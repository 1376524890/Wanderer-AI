/* 用途：为双代理辩论渲染实时 CLI 仪表盘。
不负责：运行代理逻辑或写入日志。
输入：代理循环产生的状态文件。
输出：持续更新的终端 UI。
关联：src/agent.js, src/config.js。
*/

const fs = require("fs");
const path = require("path");
const blessed = require("blessed");
const { readTail, formatUtc8, truncate } = require("./utils");

class Monitor {
  constructor(config) {
    this.config = config;
    this.statusPath = path.join(config.stateDir, "status.json");
    this.conversationPath = path.join(config.stateDir, "conversation.log");
    const identityDir = config.identityDir || config.stateDir;
    this.identityAPath = path.join(identityDir, config.identityAFile || "identity_a.md");
    this.identityBPath = path.join(identityDir, config.identityBFile || "identity_b.md");
    this.startTime = Date.now();
  }

  run() {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      autoPadding: true,
      title: "Debate Agents Console"
    });

    const header = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: "line",
      style: { border: { fg: "cyan" } }
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

    const chatBox = blessed.box({
      parent: screen,
      top: 3,
      left: 0,
      width: "60%",
      height: "100%-6",
      label: "对话内容",
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", inverse: true },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } }
    });

    const rightCol = blessed.box({
      parent: screen,
      top: 3,
      left: "60%",
      width: "40%",
      height: "100%-6"
    });

    const identityABox = blessed.box({
      parent: rightCol,
      top: 0,
      left: 0,
      width: "100%",
      height: "50%",
      label: "Agent A Identity",
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", inverse: true },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } }
    });

    const identityBBox = blessed.box({
      parent: rightCol,
      top: "50%",
      left: 0,
      width: "100%",
      height: "50%",
      label: "Agent B Identity",
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", inverse: true },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } }
    });

    const render = () => {
      const status = this.loadStatus();
      const chat = readTail(this.conversationPath, 16000);
      const identityA = readTail(this.identityAPath, 8000);
      const identityB = readTail(this.identityBPath, 8000);
      header.setContent(this.renderHeader(status));
      chatBox.setContent(chat || "(暂无对话)");
      identityABox.setContent(identityA || "(空)");
      identityBBox.setContent(identityB || "(空)");
      footer.setContent(this.renderFooter(status));
      screen.render();
    };

    const interval = setInterval(render, 500);
    render();

    screen.key(["q", "C-c"], () => {
      clearInterval(interval);
      process.exit(0);
    });
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

  renderHeader(status) {
    const nowText = formatUtc8();
    const topic = status.topic ? truncate(status.topic, 60) : "-";
    return ` 时间: ${nowText} | 主题: ${topic}`;
  }

  renderFooter(status) {
    const round = status.round !== undefined ? status.round : "-";
    const lastReply = status.last_reply_at ? this.formatUtc8FromIso(status.last_reply_at) : "-";

    const api = status.api_status || {};
    const apiState = api.ok ? "OK" : "FAIL";
    const latency = api.last_latency_ms ? `${api.last_latency_ms}ms` : "-";
    const apiError = api.last_error ? truncate(api.last_error, 80) : "";

    const tokenStats = status.token_stats || {};
    const totalTokens = tokenStats.total_tokens || 0;
    const requests = tokenStats.requests || 0;
    const tokenInfo = requests ? `${this.formatNumber(totalTokens)} (${requests} req)` : "-";

    return ` 轮次: ${round} | 上次回复: ${lastReply} | API: ${apiState} | Latency: ${latency} | Tokens: ${tokenInfo} ${apiError ? `| LastError: ${apiError}` : ""}`;
  }

  formatUtc8FromIso(iso) {
    try {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return formatUtc8(date);
    } catch (err) {
      return iso;
    }
  }

  formatNumber(num) {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return String(num);
  }
}

module.exports = { Monitor };
