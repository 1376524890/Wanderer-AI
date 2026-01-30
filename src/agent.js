/* 用途：运行自主探索主循环、执行脚本/命令并管理状态输出。
不负责：渲染监控界面。
输入：配置、日志历史与模型响应。
输出：更新日志条目、状态文件、脚本与命令执行结果。
关联：src/llmClient.js, src/journal.js, src/logger.js。
*/

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { Journal } = require("./journal");
const { LlmClient } = require("./llmClient");
const { SYSTEM_PROMPT, USER_PROMPT_TEMPLATE } = require("./prompts");
const { ensureDir, nowIso, readTail, truncate } = require("./utils");

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000));
}

class Agent {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.journal = new Journal(config.journalDir);
    this.llm = new LlmClient(config, logger);
    ensureDir(config.stateDir);
    this.statusPath = path.join(config.stateDir, "status.json");
    this.lastCommandsPath = path.join(config.stateDir, "last_commands.md");
    this.lastJournalPath = path.join(config.stateDir, "last_journal_entry.md");
    this.lastResponsePath = path.join(config.stateDir, "last_response.json");
    this.commandStreamPath = path.join(config.stateDir, "command_stream.log");
    this.lastScriptPath = path.join(config.stateDir, "last_script.py");
    this.cycle = 0;
    this.allowlistPatterns = this.buildAllowlist(config.commandAllowlist || []);
  }

  buildAllowlist(patterns) {
    const compiled = [];
    for (const raw of patterns) {
      try {
        compiled.push(new RegExp(raw));
      } catch (err) {
        // 忽略非法正则
      }
    }
    return compiled;
  }

  async runForever() {
    this.logger?.info("agent.start", { pid: process.pid });
    while (true) {
      this.cycle += 1;
      let error = "";
      let summary = "";
      let sleepSeconds = this.config.loopSleepSeconds;
      try {
        this.logger?.info("agent.cycle.start", { cycle: this.cycle });
        const result = await this.runCycle();
        summary = result.summary;
        sleepSeconds = result.sleepSeconds;
        this.logger?.info("agent.cycle.end", { cycle: this.cycle, sleepSeconds });
      } catch (err) {
        error = err && err.message ? err.message : String(err);
        this.logger?.error("agent.cycle.error", { cycle: this.cycle, error });
      }
      this.writeStatus(summary, error, sleepSeconds);
      await sleep(sleepSeconds);
    }
  }

  async runCycle() {
    const journalContext = this.journal.readRecentContext(this.config.contextMaxChars);
    const commandContext = readTail(this.lastCommandsPath, this.config.contextMaxChars);
    const userPrompt = USER_PROMPT_TEMPLATE
      .replace("{journal_context}", journalContext)
      .replace("{command_context}", commandContext || "(暂无命令输出)");

    const rawResponse = await this.llm.chat(SYSTEM_PROMPT, userPrompt);
    const parsedInfo = this.parseWithDiagnostics(rawResponse);
    const parsedSafe = parsedInfo.data || {};

    const summary = String(parsedSafe.summary || "");
    const plan = parsedSafe.plan || [];
    const commands = parsedSafe.commands || [];
    const pythonScript = this.normalizeScript(parsedSafe.python_script || parsedSafe.pythonScript || "");
    const journal = typeof parsedSafe.journal === "object" && parsedSafe.journal ? parsedSafe.journal : {};
    let what = String(journal.what || "");
    let why = String(journal.why || "");
    let learnings = String(journal.learnings || "");

    let nextSleep = parsedSafe.next_sleep_seconds || this.config.loopSleepSeconds;
    nextSleep = Number.isFinite(Number(nextSleep)) ? Number(nextSleep) : this.config.loopSleepSeconds;

    const planLines = this.normalizeList(plan);
    let commandList = this.normalizeList(commands);
    if (this.config.maxCommandsPerCycle > 0) {
      commandList = commandList.slice(0, this.config.maxCommandsPerCycle);
    }

    const rawText = String(rawResponse || "").trim();
    const missingJournal = !String(what).trim() || !String(why).trim() || !String(learnings).trim();
    if (!parsedInfo.data || missingJournal) {
      this.logger?.warn("llm.output.invalid", {
        parsed: Boolean(parsedInfo.data),
        extracted: parsedInfo.extracted,
        missingJournal,
        error: parsedInfo.error || ""
      });
      if (rawText) {
        this.appendCommandStream("=== LLM DEBUG ===\n");
        this.appendCommandStream(`parsed: ${Boolean(parsedInfo.data)} | extracted: ${parsedInfo.extracted}\n`);
        if (parsedInfo.error) {
          this.appendCommandStream(`parse_error: ${parsedInfo.error}\n`);
        }
        this.appendCommandStream(`raw_chars: ${rawText.length}\n`);
        if (parsedInfo.data) {
          const jsonText = truncate(JSON.stringify(parsedInfo.data, null, 2), 4000);
          this.appendCommandStream("[llm.json]\n");
          this.appendCommandStream(`${jsonText}\n`);
        }
        this.appendCommandStream("[llm.raw]\n");
        this.appendCommandStream(`${truncate(rawText, 12000)}\n\n`);
      }
    }


    this.resetCommandStream();
    let commandResults = [];
    if (pythonScript) {
      commandResults = await this.executePythonScript(pythonScript, commandList);
    } else {
      if (commandList.length) {
        this.logger?.warn("script.missing", { cycle: this.cycle });
        this.appendCommandStream("[warn] python_script missing; running commands directly.\n");
      }
      commandResults = await this.executeCommands(commandList);
    }
    this.writeCommands(commandResults);

    const { filePath, entry } = this.journal.appendEntry(what, why, learnings);
    fs.writeFileSync(this.lastJournalPath, entry, "utf8");

    fs.writeFileSync(
      this.lastResponsePath,
      JSON.stringify(
        {
          summary,
          plan: planLines,
          commands: commandList,
          python_script: pythonScript,
          journal: { what, why, learnings },
          raw: rawResponse
        },
        null,
        2
      ),
      "utf8"
    );

    return { summary, sleepSeconds: Math.max(1, nextSleep) };
  }

  normalizeList(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      return [value.trim()];
    }
    return [];
  }

  normalizeScript(value) {
    if (Array.isArray(value)) {
      const lines = value.map((line) => String(line));
      const joined = lines.join("\n").trim();
      return joined ? joined : "";
    }
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    return trimmed ? trimmed : "";
  }

  parseWithDiagnostics(raw) {
    const text = String(raw || "");
    const trimmed = text.trim();
    if (!trimmed) {
      return { data: null, error: "empty response", extracted: false };
    }
    try {
      return { data: JSON.parse(trimmed), error: "", extracted: false };
    } catch (err) {
      const primaryError = err && err.message ? err.message : String(err);
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        const slice = trimmed.slice(start, end + 1);
        try {
          return { data: JSON.parse(slice), error: primaryError, extracted: true };
        } catch (inner) {
          const innerError = inner && inner.message ? inner.message : String(inner);
          return {
            data: null,
            error: `${primaryError}; extract failed: ${innerError}`,
            extracted: true
          };
        }
      }
      return { data: null, error: `${primaryError}; no json object found`, extracted: false };
    }
  }

  async executeCommands(commands) {
    const results = [];
    if (!this.config.allowCommandExecution) return results;

    for (const command of commands) {
      if (!command.trim()) continue;
      if (!this.isCommandAllowed(command)) {
        this.logger?.warn("command.blocked", { command });
        this.appendCommandStream(`[blocked] ${command}\n`);
        results.push({ command, status: "blocked", output: "Command blocked" });
        continue;
      }
      try {
        this.logger?.info("command.start", { command });
        this.appendCommandStream(`>>> $ ${command}\n`);
        const output = await this.execProcess("bash", ["-lc", command]);
        this.logger?.info("command.end", { command, status: output.status });
        this.appendCommandStream(`\n[status: ${output.status}]\n\n`);
        results.push({ command, status: output.status, output: output.output });
      } catch (err) {
        this.logger?.error("command.error", { command, error: err.message || String(err) });
        this.appendCommandStream(`[error] ${err.message || String(err)}\n`);
        results.push({ command, status: "error", output: err.message || String(err) });
      }
    }

    return results;
  }

  async executePythonScript(script, commands) {
    const results = [];
    if (!this.config.allowCommandExecution) return results;
    if (!script) return results;

    const blockedReason = this.validateCommandsForScript(commands);
    if (blockedReason) {
      this.logger?.warn("script.blocked", { reason: blockedReason });
      this.appendCommandStream(`[blocked] ${blockedReason}\n`);
      results.push({ command: "python_script", status: "blocked", output: blockedReason });
      return results;
    }

    fs.writeFileSync(this.lastScriptPath, script, "utf8");
    const runner = `${this.config.pythonBin} -u ${this.lastScriptPath}`;
    this.logger?.info("script.start", { runner });
    this.appendCommandStream(`>>> $ ${runner}\n`);
    const output = await this.execProcess(this.config.pythonBin, ["-u", this.lastScriptPath]);
    this.logger?.info("script.end", { runner, status: output.status });
    this.appendCommandStream(`\n[status: ${output.status}]\n\n`);
    results.push({ command: "python_script", status: output.status, output: output.output });
    return results;
  }

  validateCommandsForScript(commands) {
    if (this.config.allowUnsafeCommands) return "";
    if (!commands || !commands.length) {
      return "Commands list is required when ALLOW_UNSAFE_COMMANDS=false";
    }
    for (const command of commands) {
      if (!this.isCommandAllowed(command)) {
        return `Command blocked: ${command}`;
      }
    }
    return "";
  }

  execProcess(command, args) {
    return new Promise((resolve) => {
      const timeoutMs = Math.max(1, this.config.commandTimeoutSeconds) * 1000;
      const child = spawn(command, args, {
        shell: false,
        env: process.env
      });

      let output = "";
      let outputTruncated = false;
      let timedOut = false;

      const handleChunk = (chunk) => {
        const text = chunk.toString();
        if (text) this.appendCommandStream(text);
        if (!outputTruncated) {
          const remaining = 8000 - output.length;
          if (remaining > 0) {
            output += text.slice(0, remaining);
          }
          if (output.length >= 8000) {
            outputTruncated = true;
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.appendCommandStream(`\n[timeout after ${this.config.commandTimeoutSeconds}s]\n`);
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", handleChunk);
      child.stderr.on("data", handleChunk);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ status: "error", output: err.message || String(err) });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        let status = "exit 0";
        if (timedOut) {
          status = "timeout";
        } else if (signal) {
          status = `signal ${signal}`;
        } else if (typeof code === "number") {
          status = `exit ${code}`;
        }
        const combined = outputTruncated ? `${output}...` : output;
        const trimmed = combined.trim();
        resolve({ status, output: trimmed ? truncate(trimmed, 2000) : "(no output)" });
      });
    });
  }

  isCommandAllowed(command) {
    if (this.config.allowUnsafeCommands) return true;
    if (!this.allowlistPatterns.length) return false;
    return this.allowlistPatterns.some((pattern) => pattern.test(command));
  }

  writeCommands(results) {
    if (!results.length) return;
    const lines = [];
    for (const item of results) {
      lines.push(`### $ ${item.command}`);
      lines.push(`Status: ${item.status}`);
      lines.push("```");
      lines.push(item.output);
      lines.push("```");
      lines.push("");
    }
    fs.writeFileSync(this.lastCommandsPath, lines.join("\n"), "utf8");
  }

  resetCommandStream() {
    fs.writeFileSync(this.commandStreamPath, "", "utf8");
  }

  appendCommandStream(text) {
    if (!text) return;
    fs.appendFileSync(this.commandStreamPath, text, "utf8");
  }

  writeStatus(summary, error, sleepSeconds) {
    const status = {
      cycle: this.cycle,
      last_summary: summary,
      last_error: error || "",
      last_run_at: nowIso(),
      sleep_seconds: sleepSeconds
    };
    fs.writeFileSync(this.statusPath, JSON.stringify(status, null, 2), "utf8");
  }
}

module.exports = { Agent };
