/* 用途：运行双代理辩论主循环，维护身份档案与状态输出。
不负责：渲染监控界面。
输入：配置、对话历史、身份档案。
输出：对话日志、身份更新、状态文件。
关联：src/llmClient.js, src/journal.js, src/prompts.js。
*/

const fs = require("fs");
const path = require("path");

const { DebateLog } = require("./journal");
const { LlmClient } = require("./llmClient");
const { buildDebatePrompts } = require("./prompts");
const { ensureDir, nowIso, readTail, truncate, safeJsonExtract, formatUtc8 } = require("./utils");

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000));
}

class DebateAgent {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.llm = new LlmClient(config, logger);
    this.log = new DebateLog(config.journalDir, config.logDir, logger);

    ensureDir(config.stateDir);
    this.statusPath = path.join(config.stateDir, "status.json");
    this.conversationPath = path.join(config.stateDir, "conversation.log");
    this.lastTurnPath = path.join(config.stateDir, "last_turn.json");
    this.tokenStatsPath = path.join(config.stateDir, "token_stats.json");

    const identityDir = config.identityDir || config.stateDir;
    ensureDir(identityDir);
    this.identityAPath = path.join(identityDir, config.identityAFile || "identity_a.md");
    this.identityBPath = path.join(identityDir, config.identityBFile || "identity_b.md");

    this.round = 0;
    this.topic = "";
    this.lastReplyAt = null;
    this.tokenStats = this.loadTokenStats();

    this.ensureIdentityFiles();
    this.loadState();
  }

  ensureIdentityFiles() {
    if (!fs.existsSync(this.identityAPath)) fs.writeFileSync(this.identityAPath, "", "utf8");
    if (!fs.existsSync(this.identityBPath)) fs.writeFileSync(this.identityBPath, "", "utf8");
    if (!fs.existsSync(this.conversationPath)) fs.writeFileSync(this.conversationPath, "", "utf8");
  }

  loadState() {
    if (!fs.existsSync(this.statusPath)) return;
    try {
      const raw = fs.readFileSync(this.statusPath, "utf8");
      const data = JSON.parse(raw);
      this.round = Number.isFinite(data.round) ? data.round : this.round;
      this.topic = typeof data.topic === "string" ? data.topic : this.topic;
      this.lastReplyAt = data.last_reply_at || this.lastReplyAt;
    } catch (err) {
      // ignore
    }
  }

  async runForever() {
    this.logger?.info("debate.start", { pid: process.pid });
    while (true) {
      let error = "";
      let sleepSeconds = this.config.loopSleepSeconds;
      try {
        const result = await this.runRound();
        sleepSeconds = result.sleepSeconds;
      } catch (err) {
        error = err && err.message ? err.message : String(err);
        this.logger?.error("debate.round.error", { error });
        this.log.appendSystemEvent("error", error);
      }
      this.writeStatus(error, sleepSeconds);
      await sleep(sleepSeconds);
    }
  }

  async runRound() {
    const nextRound = this.round + 1;
    const allowIdentityUpdate = nextRound % this.config.identityUpdateInterval === 0;
    const roundTopic = this.topic || "";

    this.log.appendRoundStart(nextRound, roundTopic);
    this.appendConversation(`\n=== Round ${nextRound} | Topic: ${roundTopic || "(待确定)"} ===\n`);

    const conversationContext = readTail(this.conversationPath, this.config.contextMaxChars);

    const agentAResult = await this.queryAgent({
      agentKey: "A",
      identityPath: this.identityAPath,
      topic: roundTopic,
      round: nextRound,
      allowIdentityUpdate,
      conversation: conversationContext
    });

    const topicAfterA = this.pickTopic(roundTopic, agentAResult.topic);
    if (topicAfterA && topicAfterA !== roundTopic) {
      this.log.appendTopicChange(roundTopic, topicAfterA, "A");
    }
    this.appendAgentReply("A", agentAResult.reply, nextRound, topicAfterA);

    const conversationAfterA = readTail(this.conversationPath, this.config.contextMaxChars);

    const agentBResult = await this.queryAgent({
      agentKey: "B",
      identityPath: this.identityBPath,
      topic: topicAfterA,
      round: nextRound,
      allowIdentityUpdate,
      conversation: conversationAfterA
    });

    const topicAfterB = this.pickTopic(topicAfterA, agentBResult.topic);
    if (topicAfterB && topicAfterB !== topicAfterA) {
      this.log.appendTopicChange(topicAfterA, topicAfterB, "B");
    }
    this.appendAgentReply("B", agentBResult.reply, nextRound, topicAfterB);

    if (allowIdentityUpdate) {
      this.applyIdentityUpdate("A", agentAResult.identityUpdate);
      this.applyIdentityUpdate("B", agentBResult.identityUpdate);
    }

    this.round = nextRound;
    this.topic = topicAfterB || topicAfterA || roundTopic;

    const lastTurn = {
      round: nextRound,
      topic: this.topic,
      agentA: agentAResult,
      agentB: agentBResult
    };
    fs.writeFileSync(this.lastTurnPath, JSON.stringify(lastTurn, null, 2), "utf8");

    return { sleepSeconds: Math.max(1, this.config.loopSleepSeconds) };
  }

  pickTopic(current, proposed) {
    const trimmed = String(proposed || "").trim();
    if (!trimmed) return current;
    return trimmed;
  }

  async queryAgent({ agentKey, identityPath, topic, round, allowIdentityUpdate, conversation }) {
    const identity = this.readIdentity(identityPath);
    const { systemPrompt, userPrompt } = buildDebatePrompts({
      agentKey,
      round,
      topic: topic || "",
      identity,
      allowIdentityUpdate,
      conversation
    });

    let rawResponse = "";
    let llmUsage = null;
    let llmError = "";

    try {
      const result = await this.llm.chat(systemPrompt, userPrompt);
      rawResponse = result.content || "";
      llmUsage = result.usage || null;
    } catch (err) {
      llmError = err && err.message ? err.message : String(err);
      this.logger?.error("debate.llm.failed", { agent: agentKey, error: llmError });
      this.log.appendSystemEvent("llm_error", `${agentKey}: ${llmError}`);
    }

    if (llmUsage) {
      this.updateTokenStats(llmUsage);
    }

    const parsed = this.parseAgentResponse(rawResponse);
    const reply = parsed.reply || (llmError ? `(API error: ${truncate(llmError, 120)})` : "(无回复)");
    const identityUpdate = allowIdentityUpdate ? parsed.identityUpdate : [];

    return {
      reply,
      topic: parsed.topic || topic || "",
      identityUpdate,
      raw: rawResponse,
      error: llmError
    };
  }

  parseAgentResponse(raw) {
    const text = String(raw || "").trim();
    if (!text) {
      return { reply: "", topic: "", identityUpdate: [] };
    }

    const json = safeJsonExtract(text);
    if (!json || typeof json !== "object") {
      return { reply: text, topic: "", identityUpdate: [] };
    }

    const reply = String(json.reply || json.response || "").trim();
    const topic = String(json.topic || "").trim();
    const update = json.identity_update || json.identityUpdate || [];
    const identityUpdate = this.normalizeList(update);
    return { reply, topic, identityUpdate };
  }

  normalizeList(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      return value
        .split("\n")
        .map((item) => item.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
    }
    return [];
  }

  readIdentity(identityPath) {
    if (!fs.existsSync(identityPath)) return "";
    try {
      return fs.readFileSync(identityPath, "utf8").trim();
    } catch (err) {
      return "";
    }
  }

  applyIdentityUpdate(agentKey, updates) {
    if (!updates || !updates.length) return;
    const identityPath = agentKey === "A" ? this.identityAPath : this.identityBPath;
    const timestamp = formatUtc8();
    const lines = updates.map((item) => `- [${timestamp}] ${item}`);
    fs.appendFileSync(identityPath, `${lines.join("\n")}\n`, "utf8");
    this.log.appendIdentityUpdate(agentKey, updates, timestamp);
  }

  appendConversation(line) {
    fs.appendFileSync(this.conversationPath, line, "utf8");
  }

  appendAgentReply(agentKey, reply, round, topic) {
    const timestamp = formatUtc8();
    const header = `[${timestamp}] ${agentKey} (Round ${round})`;
    const body = reply ? reply.trim() : "(空)";
    const content = `${header}\nTopic: ${topic || "(待定)"}\n${body}\n\n`;
    this.appendConversation(content);
    this.log.appendMessage(agentKey, body, round, topic, timestamp);
    this.lastReplyAt = nowIso();
  }

  writeStatus(lastError, sleepSeconds) {
    const llmStatus = this.llm.getStatus();
    const status = {
      round: this.round,
      topic: this.topic,
      last_reply_at: this.lastReplyAt || nowIso(),
      sleep_seconds: sleepSeconds,
      token_stats: this.tokenStats,
      api_status: llmStatus
    };

    if (lastError) {
      status.last_error = lastError;
    }

    fs.writeFileSync(this.statusPath, JSON.stringify(status, null, 2), "utf8");
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

module.exports = { DebateAgent };
