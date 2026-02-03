/* 用途：记录辩论事件与可读日志。
不负责：代理决策或界面渲染。
输入：对话、身份更新、系统事件。
输出：日志文件与每日摘要。
关联：src/agent.js。
*/

const fs = require("fs");
const path = require("path");
const { ensureDir, formatUtc8 } = require("./utils");

class DebateLog {
  constructor(journalDir, logDir, logger) {
    this.journalDir = journalDir || "journal";
    this.logDir = logDir || "logs";
    this.logger = logger;
    ensureDir(this.journalDir);
    ensureDir(this.logDir);
    this.eventLogPath = path.join(this.logDir, "debate_events.jsonl");
  }

  appendEvent(type, payload) {
    const record = {
      ts: new Date().toISOString(),
      type,
      payload
    };
    try {
      fs.appendFileSync(this.eventLogPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      this.logger?.error("debate.log.failed", { error: err.message || String(err) });
    }
  }

  appendRoundStart(round, topic) {
    const stamp = formatUtc8();
    this.appendEvent("round_start", { round, topic });
    this.appendJournalLine(`\n## ${stamp} Round ${round} | Topic: ${topic || "(待定)"}\n`);
  }

  appendMessage(agentKey, reply, round, topic, timestamp) {
    this.appendEvent("message", { round, agent: agentKey, topic, reply });
    const stamp = timestamp || formatUtc8();
    const lines = [
      `**${agentKey}** (${stamp})`,
      `Topic: ${topic || "(待定)"}`,
      reply || "(空)",
      ""
    ].join("\n");
    this.appendJournalLine(lines);
  }

  appendIdentityUpdate(agentKey, updates, timestamp) {
    if (!updates || !updates.length) return;
    this.appendEvent("identity_update", { agent: agentKey, updates });
    const stamp = timestamp || formatUtc8();
    const lines = [
      `**${agentKey} identity update** (${stamp})`,
      ...updates.map((item) => `- ${item}`),
      ""
    ].join("\n");
    this.appendJournalLine(lines);
  }

  appendTopicChange(fromTopic, toTopic, by) {
    this.appendEvent("topic_change", { from: fromTopic || "", to: toTopic || "", by });
    const stamp = formatUtc8();
    const line = `**Topic change** (${stamp}) ${fromTopic || "(空)"} -> ${toTopic || "(空)"}`;
    this.appendJournalLine(`${line}\n`);
  }

  appendSystemEvent(event, detail) {
    this.appendEvent("system", { event, detail });
    const stamp = formatUtc8();
    const line = `**System** (${stamp}) ${event}: ${detail}`;
    this.appendJournalLine(`${line}\n`);
  }

  appendJournalLine(text) {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const filePath = path.join(this.journalDir, `${day}.md`);
    fs.appendFileSync(filePath, `${text}\n`, "utf8");
  }
}

module.exports = { DebateLog };
