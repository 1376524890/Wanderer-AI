/* 用途：运行自主探索主循环并管理状态输出。
不负责：渲染监控界面。
输入：配置、日志历史与模型响应。
输出：更新日志条目、状态文件与可选命令结果。
关联：src/llmClient.js, src/journal.js, src/monitor.js。
*/

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const { Journal } = require("./journal");
const { LlmClient } = require("./llmClient");
const { SYSTEM_PROMPT, USER_PROMPT_TEMPLATE } = require("./prompts");
const { ensureDir, nowIso, readTail, safeJsonExtract, truncate } = require("./utils");

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000));
}

class Agent {
  constructor(config) {
    this.config = config;
    this.journal = new Journal(config.journalDir);
    this.llm = new LlmClient(config);
    ensureDir(config.stateDir);
    this.statusPath = path.join(config.stateDir, "status.json");
    this.lastCommandsPath = path.join(config.stateDir, "last_commands.md");
    this.lastJournalPath = path.join(config.stateDir, "last_journal_entry.md");
    this.lastResponsePath = path.join(config.stateDir, "last_response.json");
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
    console.log("代理启动，持续运行中...");
    while (true) {
      this.cycle += 1;
      let error = "";
      let summary = "";
      let sleepSeconds = this.config.loopSleepSeconds;
      try {
        const result = await this.runCycle();
        summary = result.summary;
        sleepSeconds = result.sleepSeconds;
      } catch (err) {
        error = err && err.message ? err.message : String(err);
        console.error("Cycle failed:", err);
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
    const parsed = safeJsonExtract(rawResponse) || {};

    const summary = String(parsed.summary || "");
    const plan = parsed.plan || [];
    const commands = parsed.commands || [];
    const journal = typeof parsed.journal === "object" && parsed.journal ? parsed.journal : {};
    let what = String(journal.what || "");
    let why = String(journal.why || "");
    let learnings = String(journal.learnings || "");

    let nextSleep = parsed.next_sleep_seconds || this.config.loopSleepSeconds;
    nextSleep = Number.isFinite(Number(nextSleep)) ? Number(nextSleep) : this.config.loopSleepSeconds;

    const planLines = this.normalizeList(plan);
    let commandList = this.normalizeList(commands);
    if (this.config.maxCommandsPerCycle > 0) {
      commandList = commandList.slice(0, this.config.maxCommandsPerCycle);
    }

    if (!what) what = "本轮根据上下文生成了探索计划。";
    if (!why) why = "确保探索过程持续进行并可追踪。";
    if (!learnings) learnings = "需要进一步行动以产生新的发现。";

    const commandResults = await this.executeCommands(commandList);
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
          journal: { what, why, learnings },
          raw: rawResponse
        },
        null,
        2
      ),
      "utf8"
    );

    console.log(`Cycle ${this.cycle} 完成，日志已更新：${filePath}`);
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

  async executeCommands(commands) {
    const results = [];
    if (!this.config.allowCommandExecution) return results;

    for (const command of commands) {
      if (!command.trim()) continue;
      if (!this.isCommandAllowed(command)) {
        results.push({ command, status: "blocked", output: "Command blocked" });
        continue;
      }
      try {
        const output = await this.execCommand(command);
        results.push({ command, status: output.status, output: output.output });
      } catch (err) {
        results.push({ command, status: "error", output: err.message || String(err) });
      }
    }

    return results;
  }

  execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(
        command,
        {
          shell: "bash",
          timeout: this.config.commandTimeoutSeconds * 1000,
          maxBuffer: 1024 * 1024
        },
        (error, stdout, stderr) => {
          const combined = (stdout + stderr).trim();
          const output = combined ? truncate(combined, 2000) : "(no output)";
          if (error) {
            const status = typeof error.code === "number" ? `exit ${error.code}` : "error";
            return resolve({ status, output });
          }
          resolve({ status: "exit 0", output });
        }
      );
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
