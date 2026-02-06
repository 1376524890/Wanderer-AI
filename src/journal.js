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

  appendRoundEvaluation(round, evaluation) {
    this.appendEvent("round_evaluation", { round, evaluation });
    const stamp = formatUtc8();
    const lines = [
      `**评委评分** (${stamp})`,
      `轮次: ${round}`,
      `本轮胜方: ${evaluation.round_winner}`,
      `平均分: 正方 ${evaluation.averages.A.toFixed(2)} | 反方 ${evaluation.averages.B.toFixed(2)}`,
      ``,
      `正方详细得分:`,
      `- 逻辑性: ${evaluation.scores.A.logic}/10`,
      `- 证据性: ${evaluation.scores.A.evidence}/10`,
      `- 反应度: ${evaluation.scores.A.responsiveness}/10`,
      `- 表达力: ${evaluation.scores.A.expression}/10`,
      `- 规则遵守: ${evaluation.scores.A.rule_compliance}/10`,
      ``,
      `反方详细得分:`,
      `- 逻辑性: ${evaluation.scores.B.logic}/10`,
      `- 证据性: ${evaluation.scores.B.evidence}/10`,
      `- 反应度: ${evaluation.scores.B.responsiveness}/10`,
      `- 表达力: ${evaluation.scores.B.expression}/10`,
      `- 规则遵守: ${evaluation.scores.B.rule_compliance}/10`,
      ``,
      `正方亮点:`,
      ...evaluation.highlights.A.map(h => `- ${h}`),
      ``,
      `反方亮点:`,
      ...evaluation.highlights.B.map(h => `- ${h}`),
      ``,
      `正方改进建议:`,
      ...evaluation.suggestions.A.map(s => `- ${s}`),
      ``,
      `反方改进建议:`,
      ...evaluation.suggestions.B.map(s => `- ${s}`),
      ""
    ].join("\n");
    this.appendJournalLine(lines);
  }

  appendFinalEvaluation(debateId, evaluation) {
    this.appendEvent("final_evaluation", { debateId, evaluation });
    const stamp = formatUtc8();
    const lines = [
      `\n\n# 🏆 辩论赛最终结果 [${stamp}]`,
      `## 辩题: Debate ${debateId}`,
      ``,
      `### 最终判定: ${evaluation.winner === 'A' ? '✅ 正方获胜' : evaluation.winner === 'B' ? '✅ 反方获胜' : '🤝 平局'}`,
      ``,
      `### 综合评分:`,
      `- 正方: ${evaluation.final_scores.A}/100`,
      `- 反方: ${evaluation.final_scores.B}/100`,
      ``,
      `### 关键转折点:`,
      ...evaluation.key_turning_points.map(p => `- 第${p.round}轮: ${p.description}`),
      ``,
      `### 决定性因素:`,
      ...evaluation.decisive_factors.map(f => `- ${f}`),
      ``,
      `### 正方优点:`,
      ...evaluation.strengths.A.map(s => `- ${s}`),
      ``,
      `### 正方不足:`,
      ...evaluation.weaknesses.A.map(w => `- ${w}`),
      ``,
      `### 反方优点:`,
      ...evaluation.strengths.B.map(s => `- ${s}`),
      ``,
      `### 反方不足:`,
      ...evaluation.weaknesses.B.map(w => `- ${w}`),
      ``,
      `### 整体评价:`,
      evaluation.overall_comment,
      ""
    ].join("\n");
    this.appendJournalLine(lines);
  }
}

module.exports = { DebateLog };
