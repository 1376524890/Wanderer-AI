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
    this.llmRawLogPath = path.join(config.logDir || "logs", "llm_raw.log");
    this.goalPath = path.join(config.stateDir, "current_goal.json");
    this.goalHistoryPath = path.join(config.stateDir, "goal_history.json");
    this.tokenStatsPath = path.join(config.stateDir, "token_stats.json");
    this.creativeBriefPath = config.creativeBriefPath;
    ensureDir(path.dirname(this.llmRawLogPath));
    this.cycle = 0;
    this.allowlistPatterns = this.buildAllowlist(config.commandAllowlist || []);
    this.tokenStats = this.loadTokenStats();
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
    this.resetCommandStream();
    let loadedGoal = this.loadGoal();
    if (loadedGoal && this.config.creativeOnly && this.isGoalAvoided(loadedGoal)) {
      this.logger?.warn("goal.ignored", { reason: "avoid-keywords", goal: loadedGoal });
      loadedGoal = null;
    }
    const journalContext = this.journal.readRecentContext(this.config.contextMaxChars);
    const commandContext = readTail(this.lastCommandsPath, this.config.contextMaxChars);
    const goalContext = loadedGoal ? `\n\n当前目标：\n${JSON.stringify(loadedGoal, null, 2)}` : "";
    const workdir = process.cwd();
    const creativeBrief = this.readCreativeBrief();
    const recentGoals = this.readRecentGoals(this.config.goalRecentLimit);
    const recentGoalsText = recentGoals.length
      ? recentGoals.map((goal, idx) => `${idx + 1}. ${goal.title} — ${goal.description}`).join("\n")
      : "(无)";
    const userPrompt = USER_PROMPT_TEMPLATE
      .replace("{journal_context}", journalContext)
      .replace("{command_context}", commandContext || "(暂无命令输出)")
      .replace("{goal_context}", goalContext)
      .replace("{workdir}", workdir)
      .replace("{creative_brief}", creativeBrief || "(无)")
      .replace("{recent_goals}", recentGoalsText);

    let rawResponse = "";
    let llmError = "";
    let cleanedInfo = { cleaned: "", strippedThink: false };
    let llmUsage = null;
    try {
      const llmResult = await this.llm.chat(SYSTEM_PROMPT, userPrompt);
      rawResponse = llmResult.content;
      llmUsage = llmResult.usage;
      cleanedInfo = this.cleanLlmOutput(rawResponse);
      this.appendLlmRaw(rawResponse, cleanedInfo);
    } catch (err) {
      llmError = err && err.message ? err.message : String(err);
      this.logger?.error("llm.request.failed", { error: llmError });
      this.appendCommandStream("[llm.error]\n");
      this.appendCommandStream(`base_url: ${this.config.vllmBaseUrl}\n`);
      this.appendCommandStream(`error: ${llmError}\n\n`);
    }
    const parsedInfo = this.parseWithDiagnostics(cleanedInfo.cleaned || rawResponse);
    const parsedSafe = parsedInfo.data || {};

    const summary = String(parsedSafe.summary || "");
    const thinking = String(parsedSafe.thinking || parsedSafe.thoughts || "");
    const currentGoal = parsedSafe.current_goal || null;
    const thisAction = parsedSafe.this_action || null;
    const plan = parsedSafe.plan || [];
    const commands = parsedSafe.commands || [];
    let pythonScript = this.normalizeScript(parsedSafe.python_script || parsedSafe.pythonScript || "");
    const journal = typeof parsedSafe.journal === "object" && parsedSafe.journal ? parsedSafe.journal : {};
    let nowWork = String(journal.now_work || "");
    let outcomes = String(journal.outcomes || "");
    let nextPlan = String(journal.next_plan || "");

    let nextSleep = parsedSafe.next_sleep_seconds || this.config.loopSleepSeconds;
    nextSleep = Number.isFinite(Number(nextSleep)) ? Number(nextSleep) : this.config.loopSleepSeconds;

    const planLines = this.normalizeList(plan);
    let commandList = this.normalizeList(commands);
    if (this.config.maxCommandsPerCycle > 0) {
      commandList = commandList.slice(0, this.config.maxCommandsPerCycle);
    }

    const planFirstStep = planLines[0] || "";
    const diagnosticKeywords = ["检查", "查看", "确认", "验证", "排查", "状态", "日志", "env", "ps", "df", "ls", "cat", "tail"];
    const isDiagnosticFirst = diagnosticKeywords.some((kw) => {
      if (kw === "env") return /^\s*(ls|print)?\s*env\b/.test(planFirstStep);
      if (kw === "ps") return /^\s*ps\b/.test(planFirstStep);
      if (kw === "df") return /^\s*df\b/.test(planFirstStep);
      if (kw === "ls") return /^\s*ls\b/.test(planFirstStep);
      if (kw === "cat") return /^\s*cat\b/.test(planFirstStep);
      if (kw === "tail") return /^\s*tail\b/.test(planFirstStep);
      return planFirstStep.includes(kw);
    });

    let blockedReason = "";
    let policyBlockedReason = "";
    if (isDiagnosticFirst && !llmError && parsedInfo.data) {
      blockedReason = `禁止以诊断/检查类操作作为第一步: ${planFirstStep}`;
      this.logger?.warn("plan.diagnostic.blocked", { firstStep: planFirstStep });
      this.appendCommandStream("[blocked] 禁止以诊断/检查类操作作为第一步\n");
      this.appendCommandStream(`first_step: ${planFirstStep}\n`);
    }

    if (!currentGoal && !blockedReason) {
      if (!llmError && parsedInfo.data) {
        blockedReason = "必须明确 current_goal";
        this.logger?.warn("plan.no_current_goal", {});
        this.appendCommandStream("[blocked] 必须明确 current_goal\n");
      }
    }

    if (!blockedReason) {
      const policyBlock = this.checkGoalPolicy(currentGoal, loadedGoal, recentGoals);
      if (policyBlock) {
        blockedReason = policyBlock;
        policyBlockedReason = policyBlock;
        this.logger?.warn("goal.policy.blocked", { reason: policyBlock });
        this.appendCommandStream(`[blocked] ${policyBlock}\n`);
      }
    }

    if (blockedReason) {
      if (!String(nowWork).trim()) {
        nowWork = `阻止不合规计划：${blockedReason}`;
      }
      if (!String(outcomes).trim()) {
        outcomes = "未执行任何命令或脚本。";
      }
      if (!String(nextPlan).trim()) {
        nextPlan = "下一轮需生成合规且创作导向的目标与行动。";
      }
      commandList = [];
      pythonScript = "";
    }

    const rawText = String(rawResponse || "").trim();
    const cleanedText = String(cleanedInfo.cleaned || "").trim();
    const missingJournal = !String(nowWork).trim() || !String(outcomes).trim() || !String(nextPlan).trim();
    if (!parsedInfo.data || missingJournal || llmError) {
      this.logger?.warn("llm.output.invalid", {
        parsed: Boolean(parsedInfo.data),
        extracted: parsedInfo.extracted,
        repaired: parsedInfo.repaired,
        strippedThink: cleanedInfo.strippedThink,
        missingJournal,
        error: parsedInfo.error || "",
        llmError
      });
      if (rawText) {
        this.appendCommandStream("=== LLM DEBUG ===\n");
        this.appendCommandStream(`parsed: ${Boolean(parsedInfo.data)} | extracted: ${parsedInfo.extracted}\n`);
        this.appendCommandStream(`repaired: ${parsedInfo.repaired}\n`);
        this.appendCommandStream(`stripped_think: ${cleanedInfo.strippedThink}\n`);
        if (parsedInfo.error) {
          this.appendCommandStream(`parse_error: ${parsedInfo.error}\n`);
        }
        if (llmError) {
          this.appendCommandStream(`request_error: ${llmError}\n`);
        }
        this.appendCommandStream(`raw_chars: ${rawText.length}\n`);
        if (parsedInfo.data) {
          const jsonText = truncate(JSON.stringify(parsedInfo.data, null, 2), 4000);
          this.appendCommandStream("[llm.json]\n");
          this.appendCommandStream(`${jsonText}\n`);
        }
        this.appendCommandStream("[llm.raw]\n");
        this.appendCommandStream(`${truncate(rawText, 12000)}\n\n`);
        if (cleanedText && cleanedText !== rawText) {
          this.appendCommandStream("[llm.cleaned]\n");
          this.appendCommandStream(`${truncate(cleanedText, 12000)}\n\n`);
        }
      } else if (llmError) {
        this.appendCommandStream("=== LLM DEBUG ===\n");
        this.appendCommandStream(`parsed: false | extracted: ${parsedInfo.extracted}\n`);
        this.appendCommandStream(`repaired: ${parsedInfo.repaired}\n`);
        this.appendCommandStream(`stripped_think: ${cleanedInfo.strippedThink}\n`);
        if (parsedInfo.error) {
          this.appendCommandStream(`parse_error: ${parsedInfo.error}\n`);
        }
        this.appendCommandStream(`request_error: ${llmError}\n\n`);
      }
    }

    if (!pythonScript && commandList.length) {
      pythonScript = this.buildScriptFromCommands(commandList);
      this.appendCommandStream("[llm.repair] generated python_script from commands\n");
    }


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

    const { filePath, entry } = this.journal.appendEntry(nowWork, outcomes, nextPlan);
    fs.writeFileSync(this.lastJournalPath, entry, "utf8");

    const allowGoalPersistence = !policyBlockedReason;
    if (allowGoalPersistence) {
      if (currentGoal && currentGoal.phase === "completed") {
        this.archiveGoal(currentGoal);
        this.appendCommandStream(`[goal.completed] ${currentGoal.title}\n`);
      } else if (currentGoal) {
        this.saveGoal(currentGoal);
      }
    }

    if (llmUsage) {
      this.updateTokenStats(llmUsage);
    }

    fs.writeFileSync(
      this.lastResponsePath,
      JSON.stringify(
        {
          summary,
          thinking,
          current_goal: currentGoal,
          this_action: thisAction,
          plan: planLines,
          commands: commandList,
          python_script: pythonScript,
          journal: { now_work: nowWork, outcomes, next_plan: nextPlan },
          raw: rawResponse,
          raw_cleaned: cleanedText,
          error: llmError
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

  readCreativeBrief() {
    if (this.creativeBriefPath && fs.existsSync(this.creativeBriefPath)) {
      try {
        const content = fs.readFileSync(this.creativeBriefPath, "utf8");
        return content.trim();
      } catch (err) {
        return "";
      }
    }
    return String(process.env.CREATIVE_BRIEF || "").trim();
  }

  readRecentGoals(limit) {
    if (!fs.existsSync(this.goalHistoryPath)) return [];
    try {
      const raw = fs.readFileSync(this.goalHistoryPath, "utf8");
      const history = JSON.parse(raw);
      if (!Array.isArray(history)) return [];
      const count = Math.max(0, Number(limit) || 0);
      if (!count) return [];
      return history.slice(-count).reverse().map((goal) => ({
        id: String(goal.id || ""),
        title: String(goal.title || ""),
        description: String(goal.description || "")
      }));
    } catch (err) {
      return [];
    }
  }

  isGoalAvoided(goal) {
    if (!goal) return false;
    const goalText = `${goal.title || ""} ${goal.description || ""}`.toLowerCase();
    const avoidKeywords = Array.isArray(this.config.goalAvoidKeywords)
      ? this.config.goalAvoidKeywords
      : [];
    return avoidKeywords.some((kw) => kw && goalText.includes(String(kw).toLowerCase()));
  }

  checkGoalPolicy(currentGoal, loadedGoal, recentGoals) {
    if (!currentGoal || !this.config.creativeOnly) return "";
    const isNewGoal = !loadedGoal || loadedGoal.id !== currentGoal.id;
    const goalText = `${currentGoal.title || ""} ${currentGoal.description || ""}`.toLowerCase();
    if (this.isGoalAvoided(currentGoal)) {
      return "目标命中运维/工具类关键词，已阻止并要求创作型目标";
    }

    if (isNewGoal && Array.isArray(recentGoals) && recentGoals.length) {
      const normalized = goalText.replace(/\s+/g, "");
      const repeated = recentGoals.some((goal) => {
        const title = String(goal.title || "").toLowerCase().replace(/\s+/g, "");
        const desc = String(goal.description || "").toLowerCase().replace(/\s+/g, "");
        return (title && normalized.includes(title)) || (desc && normalized.includes(desc));
      });
      if (repeated) {
        return "新目标与近期目标高度重复，已阻止并要求显著不同的创作主题";
      }
    }

    return "";
  }

  parseWithDiagnostics(raw) {
    const text = String(raw || "");
    const trimmed = text.trim();
    if (!trimmed) {
      return { data: null, error: "empty response", extracted: false, repaired: false };
    }
    try {
      return { data: JSON.parse(trimmed), error: "", extracted: false, repaired: false };
    } catch (err) {
      const primaryError = err && err.message ? err.message : String(err);
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        const slice = trimmed.slice(start, end + 1);
        try {
          return { data: JSON.parse(slice), error: primaryError, extracted: true, repaired: false };
        } catch (inner) {
          const innerError = inner && inner.message ? inner.message : String(inner);
          const repaired = this.tryRepairJson(slice);
          if (repaired) {
            return { data: repaired, error: `${primaryError}; repaired`, extracted: true, repaired: true };
          }
          return {
            data: null,
            error: `${primaryError}; extract failed: ${innerError}`,
            extracted: true,
            repaired: false
          };
        }
      }
      const repaired = this.tryRepairJson(trimmed);
      if (repaired) {
        return { data: repaired, error: `${primaryError}; repaired`, extracted: false, repaired: true };
      }
      return { data: null, error: `${primaryError}; no json object found`, extracted: false, repaired: false };
    }
  }

  tryRepairJson(text) {
    if (!text) return null;
    const braceStart = text.indexOf("{");
    if (braceStart === -1) return null;
    const candidate = text.slice(braceStart);
    const scriptIndex = candidate.indexOf("\"python_script\"");
    if (scriptIndex === -1) return null;
    const before = candidate.slice(0, scriptIndex).replace(/,\s*$/, "");
    const repaired = `${before}\n}`;
    try {
      return JSON.parse(repaired);
    } catch (err) {
      return null;
    }
  }

  buildScriptFromCommands(commands) {
    const safe = commands.map((item) => String(item));
    const lines = [
      "import subprocess",
      "commands = ["
    ];
    for (const cmd of safe) {
      lines.push(`    ${JSON.stringify(cmd)},`);
    }
    lines.push("]");
    lines.push("for cmd in commands:");
    lines.push("    print(f'>>> $ {cmd}', flush=True)");
    lines.push("    result = subprocess.run(cmd, shell=True, text=True, capture_output=True)");
    lines.push("    if result.stdout:");
    lines.push("        print(result.stdout, end='', flush=True)");
    lines.push("    if result.stderr:");
    lines.push("        print(result.stderr, end='', flush=True)");
    lines.push("    if result.returncode != 0:");
    lines.push("        print(f'[exit {result.returncode}]', flush=True)");
    lines.push("        break");
    return lines.join("\n");
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

  cleanLlmOutput(raw) {
    const text = String(raw || "");
    const trimmed = text.trim();
    if (!trimmed) return { cleaned: "", strippedThink: false };
    let cleaned = trimmed.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    let strippedThink = cleaned !== trimmed;
    if (!cleaned && trimmed) {
      cleaned = trimmed;
    }
    if (cleaned.includes("<think>")) {
      strippedThink = true;
      const firstBrace = cleaned.indexOf("{");
      cleaned = (firstBrace !== -1 ? cleaned.slice(firstBrace) : cleaned).replace(/<think>/gi, "").trim();
    }
    const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }
    return { cleaned, strippedThink };
  }

  appendLlmRaw(raw, cleanedInfo) {
    if (!raw) return;
    const header = `--- ${nowIso()} cycle:${this.cycle} ---\n`;
    let payload = header + String(raw).trim() + "\n\n";
    if (cleanedInfo && cleanedInfo.strippedThink && cleanedInfo.cleaned) {
      payload += `[cleaned]\n${String(cleanedInfo.cleaned).trim()}\n\n`;
    }
    fs.appendFileSync(this.llmRawLogPath, payload, "utf8");
  }

  writeStatus(summary, error, sleepSeconds) {
    const status = {
      cycle: this.cycle,
      last_summary: summary,
      last_error: error || "",
      last_run_at: nowIso(),
      sleep_seconds: sleepSeconds,
      token_stats: this.tokenStats
    };
    fs.writeFileSync(this.statusPath, JSON.stringify(status, null, 2), "utf8");
  }

  loadGoal() {
    if (!fs.existsSync(this.goalPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.goalPath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  saveGoal(goal) {
    if (!goal) return;
    fs.writeFileSync(this.goalPath, JSON.stringify(goal, null, 2), "utf8");
  }

  archiveGoal(goal) {
    if (!goal) return;
    let history = [];
    try {
      if (fs.existsSync(this.goalHistoryPath)) {
        history = JSON.parse(fs.readFileSync(this.goalHistoryPath, "utf8"));
      }
    } catch (err) {}

    goal.completed_at = nowIso();
    goal.cycles = this.cycle;
    history.push(goal);
    fs.writeFileSync(this.goalHistoryPath, JSON.stringify(history, null, 2), "utf8");
    fs.unlinkSync(this.goalPath);
  }

  loadTokenStats() {
    const defaults = {
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_tokens: 0,
      requests: 0,
      last_updated: null
    };

    if (!fs.existsSync(this.tokenStatsPath)) {
      return defaults;
    }

    try {
      const raw = fs.readFileSync(this.tokenStatsPath, "utf8");
      const stats = JSON.parse(raw);
      return { ...defaults, ...stats };
    } catch (err) {
      return defaults;
    }
  }

  updateTokenStats(usage) {
    if (!usage) return;

    this.tokenStats.total_prompt_tokens += usage.prompt_tokens || 0;
    this.tokenStats.total_completion_tokens += usage.completion_tokens || 0;
    this.tokenStats.total_tokens += usage.total_tokens || 0;
    this.tokenStats.requests += 1;
    this.tokenStats.last_updated = nowIso();

    try {
      fs.writeFileSync(this.tokenStatsPath, JSON.stringify(this.tokenStats, null, 2), "utf8");
    } catch (err) {
      this.logger?.error("token.stats.save.failed", { error: err.message });
    }
  }
}

module.exports = { Agent };
