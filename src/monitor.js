/* 用途：为运行中的代理渲染实时 CLI 仪表盘。
不负责：运行代理逻辑或写入日志。
输入：代理循环产生的状态文件。
输出：持续更新的终端 UI。
关联：src/agent.js, src/config.js。
*/

const fs = require("fs");
const path = require("path");
const blessed = require("blessed");
const { readTail } = require("./utils");

class Monitor {
  constructor(config) {
    this.config = config;
    this.statusPath = path.join(config.stateDir, "status.json");
    this.lastJournalPath = path.join(config.stateDir, "last_journal_entry.md");
    this.lastCommandsPath = path.join(config.stateDir, "last_commands.md");
    this.startTime = Date.now();
  }

  run() {
    const screen = blessed.screen({
      smartCSR: true,
      title: "Wanderer AI 控制台"
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

    const journalBox = blessed.box({
      parent: screen,
      top: 3,
      left: 0,
      width: "70%",
      height: "100%-6",
      label: "探索日志",
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", inverse: true },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } }
    });

    const statusBox = blessed.box({
      parent: screen,
      top: 3,
      left: "70%",
      width: "30%",
      height: "40%",
      label: "状态",
      border: "line",
      tags: false,
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } }
    });

    const commandBox = blessed.box({
      parent: screen,
      top: "43%",
      left: "70%",
      width: "30%",
      height: "100%-46%",
      label: "命令输出",
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
      header.setContent(this.renderHeader());
      statusBox.setContent(this.renderStatus());
      journalBox.setContent(readTail(this.lastJournalPath, 5000) || "(暂无日志)");
      commandBox.setContent(readTail(this.lastCommandsPath, 2000) || "(暂无命令执行)");
      footer.setContent("快捷键：q 退出 | Ctrl+C 退出");
      screen.render();
    };

    const interval = setInterval(render, 500);
    render();

    screen.key(["q", "C-c"], () => {
      clearInterval(interval);
      process.exit(0);
    });
  }

  renderHeader() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const uptimeText = `${hours}h ${minutes}m ${seconds}s`;
    return ` Wanderer AI · Claude 风格监控  |  Uptime: ${uptimeText}`;
  }

  renderStatus() {
    const data = this.loadStatus();
    const lines = [
      `轮次: ${data.cycle ?? "-"}`,
      `上次运行: ${data.last_run_at ?? "-"}`,
      `休眠: ${data.sleep_seconds ?? "-"}s`,
      `总结: ${data.last_summary ?? ""}`
    ];
    if (data.last_error) {
      lines.push(`错误: ${data.last_error}`);
    }
    return lines.join("\n");
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
}

module.exports = { Monitor };
