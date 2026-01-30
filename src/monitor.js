/* 用途：为运行中的代理渲染实时 CLI 仪表盘。
不负责：运行代理逻辑或写入日志。
输入：代理循环产生的状态文件。
输出：持续更新的终端 UI。
关联：src/agent.js, src/config.js。
*/

const fs = require("fs");
const path = require("path");
const blessed = require("blessed");
const { readTail, safeJsonExtract, truncate } = require("./utils");

class Monitor {
  constructor(config) {
    this.config = config;
    this.statusPath = path.join(config.stateDir, "status.json");
    this.lastCommandsPath = path.join(config.stateDir, "last_commands.md");
    this.commandStreamPath = path.join(config.stateDir, "command_stream.log");
    this.lastResponsePath = path.join(config.stateDir, "last_response.json");
    this.startTime = Date.now();
  }

  run() {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      autoPadding: true,
      title: "Wanderer AI Console"
    });

    const labels = {
      thinking: "思考过程",
      actions: "采取的措施",
      footer: "Keys: q to quit | Ctrl+C to quit"
    };

    const header = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: "line",
      style: { border: { fg: "cyan" } }
    });

    const thinkingBox = blessed.box({
      parent: screen,
      top: 3,
      left: 0,
      width: "65%",
      height: "100%-6",
      label: labels.thinking,
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", inverse: true },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } }
    });

    const actionBox = blessed.box({
      parent: screen,
      top: 3,
      left: "65%",
      width: "35%",
      height: "100%-6",
      label: labels.actions,
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      tags: false,
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } }
    });

    const footer = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: "line",
      style: { border: { fg: "cyan" } }
    });

    const render = () => {
      const status = this.loadStatus();
      const response = this.loadResponse();
      const live = readTail(this.commandStreamPath, 12000);
      const lastCommands = readTail(this.lastCommandsPath, 4000);
      header.setContent(this.renderHeader(status));
      thinkingBox.setContent(this.renderThinking(response));
      actionBox.setContent(this.renderActions(response, status, live, lastCommands));
      footer.setContent(labels.footer);
      screen.render();
    };

    const interval = setInterval(render, 500);
    render();

    screen.key(["q", "C-c"], () => {
      clearInterval(interval);
      process.exit(0);
    });
  }

  renderHeader(status) {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const uptimeText = `${hours}h ${minutes}m ${seconds}s`;
    const cycle = status && status.cycle !== undefined ? status.cycle : "-";
    const lastRun = status && status.last_run_at ? status.last_run_at : "-";
    const sleep = status && status.sleep_seconds !== undefined ? `${status.sleep_seconds}s` : "-";
    return ` Wanderer AI | Uptime: ${uptimeText} | Cycle: ${cycle} | Last: ${lastRun} | Sleep: ${sleep}`;
  }

  loadStatus() {
    if (!fs.existsSync(this.statusPath)) return {};
    try {
      const raw = fs.readFileSync(this.statusPath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      return {};
    }
  }

  loadResponse() {
    if (!fs.existsSync(this.lastResponsePath)) return {};
    try {
      const raw = fs.readFileSync(this.lastResponsePath, "utf8");
      return safeJsonExtract(raw) || {};
    } catch (err) {
      return {};
    }
  }

  renderThinking(response) {
    const lines = [];
    const summary = String(response.summary || "").trim();
    const thinking = String(response.thinking || response.thoughts || "").trim();
    const journal = response.journal && typeof response.journal === "object" ? response.journal : {};
    const outcomes = String(journal.outcomes || "").trim();
    const nextPlan = String(journal.next_plan || "").trim();
    const plan = this.normalizeList(response.plan);

    if (summary) {
      lines.push("【当前总结】", summary, "");
    }
    if (thinking) {
      lines.push("【思考摘要】", thinking, "");
    }
    if (outcomes) {
      lines.push("【达成的成果】", outcomes, "");
    }
    if (plan.length) {
      lines.push("【计划】");
      plan.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });
      lines.push("");
    }
    if (nextPlan) {
      lines.push("【下一步计划】", nextPlan, "");
    }

    if (!lines.length) return "(暂无思考内容)";
    return lines.join("\n");
  }

  renderActions(response, status, live, lastCommands) {
    const lines = [];
    const journal = response.journal && typeof response.journal === "object" ? response.journal : {};
    const nowWork = String(journal.now_work || "").trim();
    const commands = this.normalizeList(response.commands);
    const pythonScript = String(response.python_script || "").trim();
    const summary = String(response.summary || "").trim();
    const output = live || lastCommands || "";

    lines.push("【运行状态】");
    lines.push(`Cycle: ${status.cycle ?? "-"}`);
    lines.push(`Last run: ${status.last_run_at ?? "-"}`);
    lines.push(`Sleep: ${status.sleep_seconds ?? "-"}s`);
    if (status.last_error) {
      lines.push(`Error: ${status.last_error}`);
    }
    if (summary) {
      lines.push(`Summary: ${summary}`);
    }
    lines.push("");

    if (nowWork) {
      lines.push("【正在进行的工作】", nowWork, "");
    }

    lines.push("【命令清单】");
    if (commands.length) {
      commands.forEach((item) => lines.push(`- ${item}`));
    } else {
      lines.push("(未生成 commands)");
    }
    lines.push("");

    if (pythonScript) {
      lines.push("【python_script】");
      lines.push(truncate(pythonScript, 2000));
      lines.push("");
    }

    lines.push("【命令输出】");
    if (output) {
      lines.push(output);
    } else {
      lines.push("(暂无实时输出)");
      const hints = this.commandOutputHints(commands, pythonScript);
      if (hints.length) {
        hints.forEach((hint) => lines.push(`- ${hint}`));
      }
    }

    return lines.join("\n");
  }

  commandOutputHints(commands, pythonScript) {
    const hints = [];
    if (!this.config.allowCommandExecution) {
      hints.push("ALLOW_COMMAND_EXECUTION=false，命令执行被禁用");
    }
    if (!commands.length) {
      hints.push("本轮未生成 commands 列表");
    }
    if (!pythonScript) {
      hints.push("本轮未生成 python_script");
    }
    if (!this.config.allowUnsafeCommands && !commands.length) {
      hints.push("ALLOW_UNSAFE_COMMANDS=false 时必须提供 commands 列表");
    }
    if (!this.config.allowUnsafeCommands && !this.config.commandAllowlist.length) {
      hints.push("COMMAND_ALLOWLIST 为空，所有命令会被拦截");
    }
    return hints;
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
}

module.exports = { Monitor };
