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
const { buildDebateFlow, formatStageLengthGuide, getStageLengthGuide } = require("./workflow");
const { ensureDir, nowIso, readTail, truncate, safeJsonExtract, formatUtc8 } = require("./utils");

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000));
}

function normalizeOp(op) {
  const raw = String(op || "").trim().toLowerCase();
  if (!raw) return "";
  if (["add", "新增", "添加", "补充"].includes(raw)) return "add";
  if (["del", "delete", "remove", "删除", "移除"].includes(raw)) return "del";
  if (["change", "update", "replace", "修改", "变更", "替换"].includes(raw)) return "change";
  return raw;
}

function parseIdentityOps(updates) {
  if (!Array.isArray(updates)) return [];
  const ops = [];

  for (const item of updates) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) continue;
      const addMatch = text.match(/^(add|新增|添加|补充)\s*[:：]\s*(.+)$/i);
      const delMatch = text.match(/^(del|delete|remove|删除|移除)\s*[:：]\s*(.+)$/i);
      const changeMatch = text.match(/^(change|update|replace|修改|变更|替换)\s*[:：]\s*(.+?)(?:\s*->\s*|\s*=>\s*|→)\s*(.+)$/i);
      if (changeMatch) {
        ops.push({ op: "change", from: changeMatch[2].trim(), to: changeMatch[3].trim() });
      } else if (delMatch) {
        ops.push({ op: "del", text: delMatch[2].trim() });
      } else if (addMatch) {
        ops.push({ op: "add", text: addMatch[2].trim() });
      } else {
        ops.push({ op: "add", text });
      }
      continue;
    }

    if (item && typeof item === "object") {
      const op = normalizeOp(item.op || item.action || item.type);
      if (op === "add") {
        const text = String(item.text || item.value || item.content || "").trim();
        if (text) ops.push({ op, text });
        continue;
      }
      if (op === "del") {
        const text = String(item.text || item.value || item.content || "").trim();
        if (text) ops.push({ op, text });
        continue;
      }
      if (op === "change") {
        const from = String(item.from || item.old || "").trim();
        const to = String(item.to || item.new || item.text || "").trim();
        if (from && to) ops.push({ op, from, to });
        continue;
      }
    }
  }

  return ops;
}

function stripIdentityPrefix(line) {
  const match = String(line || "").match(/^\s*-\s*\[[^\]]+\]\s*(.*)$/);
  return match ? match[1].trim() : String(line || "").trim();
}

function formatIdentityLine(text, timestamp) {
  return `- [${timestamp}] ${text}`;
}

function matchIdentityLine(lineText, query) {
  if (!lineText || !query) return false;
  return lineText.toLowerCase().includes(query.toLowerCase());
}

function buildConversationEntry(agentKey, reply, round, topic) {
  const timestamp = formatUtc8();
  const header = `[${timestamp}] ${agentKey} (Round ${round})`;
  const body = reply ? reply.trim() : "(空)";
  return `${header}\nTopic: ${topic || "(待定)"}\n${body}\n\n`;
}

function appendAndTrimConversation(base, addition, maxChars) {
  const prefix = base && !base.endsWith("\n") ? "\n" : "";
  const combined = `${base || ""}${prefix}${addition || ""}`;
  if (!maxChars || combined.length <= maxChars) return combined;
  return combined.slice(-maxChars);
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

    const experienceDir = config.experienceDir || config.stateDir;
    ensureDir(experienceDir);
    this.experiencePath = path.join(experienceDir, config.experienceFile || "experience.md");

    const archiveDir = config.archiveDir || path.join(config.stateDir, "archives");
    ensureDir(archiveDir);
    this.archiveDir = archiveDir;

    this.round = 0;
    this.debateRound = 0;
    this.debateId = 1;
    this.topic = "";
    this.lastReplyAt = null;
    this.tokenStats = this.loadTokenStats();
    this.debateFlow = buildDebateFlow(config.freeDebateRounds);

    this.ensureIdentityFiles();
    this.loadState();
  }

  ensureIdentityFiles() {
    if (!fs.existsSync(this.identityAPath)) fs.writeFileSync(this.identityAPath, "", "utf8");
    if (!fs.existsSync(this.identityBPath)) fs.writeFileSync(this.identityBPath, "", "utf8");
    if (!fs.existsSync(this.conversationPath)) fs.writeFileSync(this.conversationPath, "", "utf8");
    if (!fs.existsSync(this.experiencePath)) fs.writeFileSync(this.experiencePath, "", "utf8");
  }

  archiveCurrentDebate(debateId, topic) {
    if (!fs.existsSync(this.conversationPath)) return;
    try {
      const conversationContent = fs.readFileSync(this.conversationPath, "utf8");
      if (!conversationContent.trim()) return;

      const timestamp = nowIso().replace(/[:.]/g, "-").slice(0, 19);
      const safeTopic = (topic || "untitled").replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 50);
      const archiveFileName = `debate_${debateId}_${timestamp}_${safeTopic}.log`;
      const archiveFilePath = path.join(this.archiveDir, archiveFileName);

      fs.writeFileSync(archiveFilePath, conversationContent, "utf8");

      fs.writeFileSync(this.conversationPath, "", "utf8");

      this.logger?.info("debate.archived", { debateId, topic, archivePath: archiveFilePath });
      this.log.appendSystemEvent("archive", `Debate ${debateId} archived to ${archiveFileName}`);
    } catch (err) {
      this.logger?.error("debate.archive.failed", { error: err.message });
    }
  }

  loadState() {
    if (!fs.existsSync(this.statusPath)) return;
    try {
      const raw = fs.readFileSync(this.statusPath, "utf8");
      const data = JSON.parse(raw);
      this.round = Number.isFinite(data.round) ? data.round : this.round;
      this.debateRound = Number.isFinite(data.debate_round) ? data.debate_round : this.debateRound;
      this.debateId = Number.isFinite(data.debate_id) ? data.debate_id : this.debateId;
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
    const currentDebateId = this.debateId;
    const nextDebateRound = this.debateRound + 1;
    const debateStep = this.debateFlow[nextDebateRound - 1] || this.debateFlow[this.debateFlow.length - 1];
    const debateTotalRounds = this.debateFlow.length;
    const isDebateStart = nextDebateRound === 1;
    const isDebateEnd = nextDebateRound === debateTotalRounds;
    const allowIdentityUpdate = true;
    const roundTopic = this.topic || "";

    const conversationContext = readTail(this.conversationPath, this.config.contextMaxChars);

    const firstAgent = debateStep.order === "B" ? "B" : "A";
    const secondAgent = firstAgent === "A" ? "B" : "A";

    const allowIdentityUpdateAlways = true;
    const agentFirstResult = await this.queryAgent({
      agentKey: firstAgent,
      identityPath: firstAgent === "A" ? this.identityAPath : this.identityBPath,
      topic: roundTopic,
      round: nextRound,
      debateId: currentDebateId,
      debateRound: nextDebateRound,
      debateTotalRounds,
      stageKey: debateStep.key,
      stageTitle: debateStep.title,
      stageRule: debateStep.rule,
      lengthGuide: getStageLengthGuide(debateStep, firstAgent),
      role: debateStep.roles[firstAgent],
      task: debateStep.tasks[firstAgent],
      speakerOrder: "first",
      allowIdentityUpdate: allowIdentityUpdateAlways,
      isDebateStart,
      isDebateEnd,
      experience: this.readExperience(),
      conversation: conversationContext
    });

    if (agentFirstResult.error) {
      const error = `Agent ${firstAgent} failed: ${truncate(agentFirstResult.error, 120)}`;
      this.log.appendSystemEvent("round_retry", error);
      throw new Error(error);
    }

    const topicAfterFirst = this.pickTopic(roundTopic, agentFirstResult.topic);
    const virtualFirstEntry = buildConversationEntry(firstAgent, agentFirstResult.reply, nextRound, topicAfterFirst);
    const conversationAfterFirst = appendAndTrimConversation(
      conversationContext,
      virtualFirstEntry,
      this.config.contextMaxChars
    );

    const agentSecondResult = await this.queryAgent({
      agentKey: secondAgent,
      identityPath: secondAgent === "A" ? this.identityAPath : this.identityBPath,
      topic: topicAfterFirst,
      round: nextRound,
      debateId: currentDebateId,
      debateRound: nextDebateRound,
      debateTotalRounds,
      stageKey: debateStep.key,
      stageTitle: debateStep.title,
      stageRule: debateStep.rule,
      lengthGuide: getStageLengthGuide(debateStep, secondAgent),
      role: debateStep.roles[secondAgent],
      task: debateStep.tasks[secondAgent],
      speakerOrder: "second",
      allowIdentityUpdate: allowIdentityUpdateAlways,
      isDebateStart,
      isDebateEnd,
      experience: this.readExperience(),
      conversation: conversationAfterFirst
    });

    if (agentSecondResult.error) {
      const error = `Agent ${secondAgent} failed: ${truncate(agentSecondResult.error, 120)}`;
      this.log.appendSystemEvent("round_retry", error);
      throw new Error(error);
    }

    const topicAfterSecond = this.pickTopic(topicAfterFirst, agentSecondResult.topic);
    this.log.appendRoundStart(nextRound, roundTopic);
    this.appendConversation(`\n=== Round ${nextRound} | Topic: ${roundTopic || "(待确定)"} ===\n`);
    if (topicAfterFirst && topicAfterFirst !== roundTopic) {
      this.log.appendTopicChange(roundTopic, topicAfterFirst, firstAgent);
    }
    this.appendAgentReply(firstAgent, agentFirstResult.reply, nextRound, topicAfterFirst, debateStep.title);
    if (topicAfterSecond && topicAfterSecond !== topicAfterFirst) {
      this.log.appendTopicChange(topicAfterFirst, topicAfterSecond, secondAgent);
    }
    this.appendAgentReply(secondAgent, agentSecondResult.reply, nextRound, topicAfterSecond, debateStep.title);

    const resultsByAgent = {
      [agentFirstResult.agentKey]: agentFirstResult,
      [agentSecondResult.agentKey]: agentSecondResult
    };

    this.applyIdentityUpdate("A", resultsByAgent.A ? resultsByAgent.A.planUpdate : []);
    this.applyIdentityUpdate("B", resultsByAgent.B ? resultsByAgent.B.planUpdate : []);

    this.round = nextRound;
    const resolvedTopic = topicAfterSecond || topicAfterFirst || roundTopic;
    this.topic = resolvedTopic;
    this.debateRound = isDebateEnd ? 0 : nextDebateRound;

    const lastTurn = {
      round: nextRound,
      debate_round: nextDebateRound,
      debate_id: currentDebateId,
      stage: debateStep.title,
      topic: resolvedTopic,
      agentA: resultsByAgent.A,
      agentB: resultsByAgent.B
    };
    fs.writeFileSync(this.lastTurnPath, JSON.stringify(lastTurn, null, 2), "utf8");

    if (isDebateEnd) {
      this.appendExperienceUpdate(currentDebateId, resolvedTopic, [
        { agentKey: "A", updates: lastTurn.agentA.experienceUpdate },
        { agentKey: "B", updates: lastTurn.agentB.experienceUpdate }
      ]);
      this.resetIdentityFiles();
      this.topic = "";
      this.log.appendSystemEvent("debate_end", `Debate ${currentDebateId} completed`);
      this.debateId += 1;
    }

    return { sleepSeconds: Math.max(1, this.config.loopSleepSeconds) };
  }

  pickTopic(current, proposed) {
    const trimmed = String(proposed || "").trim();
    if (!trimmed) return current;
    return trimmed;
  }

  async queryAgent({
    agentKey,
    identityPath,
    topic,
    round,
    debateId,
    debateRound,
    debateTotalRounds,
    stageKey,
    stageTitle,
    stageRule,
    lengthGuide,
    role,
    task,
    speakerOrder,
    allowIdentityUpdate,
    isDebateStart,
    isDebateEnd,
    experience,
    conversation
  }) {
    const identity = this.readIdentity(identityPath);
    const { systemPrompt, userPrompt } = buildDebatePrompts({
      agentKey,
      round,
      debateId,
      debateRound,
      debateTotalRounds,
      stageKey,
      stageTitle,
      stageRule,
      lengthGuide,
      role,
      task,
      speakerOrder,
      topic: topic || "",
      identity,
      allowIdentityUpdate,
      experience,
      isDebateStart,
      isDebateEnd,
      conversation
    });

    let rawResponse = "";
    let llmUsage = null;
    let llmError = "";
    const model = this.getModelForAgent(agentKey);

    try {
      const result = await this.llm.chat(systemPrompt, userPrompt, { model });
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
    const planUpdate = allowIdentityUpdate ? parsed.planUpdate : [];
    const experienceUpdate = parsed.experienceUpdate || [];

    return {
      agentKey,
      reply,
      topic: parsed.topic || topic || "",
      planUpdate,
      experienceUpdate,
      raw: rawResponse,
      error: llmError
    };
  }

  parseAgentResponse(raw) {
    const text = String(raw || "").trim();
    if (!text) {
      return { reply: "", topic: "", planUpdate: [], experienceUpdate: [] };
    }

    const json = safeJsonExtract(text);
    if (!json || typeof json !== "object") {
      return { reply: text, topic: "", planUpdate: [], experienceUpdate: [] };
    }

    const reply = String(json.reply || json.response || "").trim();
    const topic = String(json.topic || "").trim();
    const update = json.plan_update || json.planUpdate || json.identity_update || json.identityUpdate || [];
    const planUpdate = this.normalizeUpdateList(update);
    const expUpdate = json.experience_update || json.experienceUpdate || [];
    const experienceUpdate = this.normalizeList(expUpdate);
    return { reply, topic, planUpdate, experienceUpdate };
  }

  normalizeList(value) {
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      return value
        .split("\n")
        .map((item) => item.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
    }
    return [];
  }

  normalizeUpdateList(value) {
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (item && typeof item === "object") return item;
          return null;
        })
        .filter(Boolean);
    }
    if (value && typeof value === "object") {
      return [value];
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
    const ops = parseIdentityOps(updates);
    if (!ops.length) return;

    const raw = fs.existsSync(identityPath) ? fs.readFileSync(identityPath, "utf8") : "";
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let changed = false;
    let updatedLines = [...lines];
    const applied = [];

    for (const op of ops) {
      if (op.op === "add" && op.text) {
        updatedLines.push(formatIdentityLine(op.text, timestamp));
        applied.push(`add: ${op.text}`);
        changed = true;
        continue;
      }
      if (op.op === "del" && op.text) {
        const before = updatedLines.length;
        updatedLines = updatedLines.filter((line) => !matchIdentityLine(stripIdentityPrefix(line), op.text));
        if (updatedLines.length !== before) {
          applied.push(`del: ${op.text}`);
          changed = true;
        }
        continue;
      }
      if (op.op === "change" && op.from && op.to) {
        const index = updatedLines.findIndex((line) => matchIdentityLine(stripIdentityPrefix(line), op.from));
        if (index !== -1) {
          updatedLines[index] = formatIdentityLine(op.to, timestamp);
          applied.push(`change: ${op.from} -> ${op.to}`);
          changed = true;
        } else {
          updatedLines.push(formatIdentityLine(op.to, timestamp));
          applied.push(`change: ${op.from} -> ${op.to}`);
          changed = true;
        }
      }
    }

    if (changed) {
      const payload = updatedLines.length ? `${updatedLines.join("\n")}\n` : "";
      fs.writeFileSync(identityPath, payload, "utf8");
      this.log.appendIdentityUpdate(agentKey, applied, timestamp);
    }
  }

  appendConversation(line) {
    fs.appendFileSync(this.conversationPath, line, "utf8");
  }

  appendAgentReply(agentKey, reply, round, topic, stage) {
    const timestamp = formatUtc8();
    const header = `[${timestamp}] ${agentKey} (Round ${round})`;
    const body = reply ? reply.trim() : "(空)";
    const stageLine = stage ? `Stage: ${stage}\n` : "";
    const content = `${header}\nTopic: ${topic || "(待定)"}\n${stageLine}${body}\n\n`;
    this.appendConversation(content);
    this.log.appendMessage(agentKey, body, round, topic, timestamp);
    this.lastReplyAt = nowIso();
  }

  writeStatus(lastError, sleepSeconds) {
    const llmStatus = this.llm.getStatus();
    const stageMeta = this.getDebateStageMeta();
    const status = {
      round: this.round,
      debate_round: this.debateRound,
      debate_id: this.debateId,
      debate_stage: stageMeta.title,
      debate_stage_key: stageMeta.key,
      debate_stage_rule: stageMeta.rule,
      debate_stage_length: stageMeta.lengthGuide,
      debate_total_rounds: this.debateFlow.length,
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

  getDebateStageMeta() {
    if (!this.debateRound) {
      return { key: "-", title: "-", rule: "-", lengthGuide: "-" };
    }
    const step = this.debateFlow[this.debateRound - 1];
    if (!step) {
      return { key: "-", title: "-", rule: "-", lengthGuide: "-" };
    }
    return {
      key: step.key || "-",
      title: step.title || "-",
      rule: step.rule || "-",
      lengthGuide: formatStageLengthGuide(step)
    };
  }

  getModelForAgent(agentKey) {
    const fallback = this.config.vllmModel;
    if (agentKey === "A") return this.config.vllmModelA || fallback;
    if (agentKey === "B") return this.config.vllmModelB || fallback;
    return fallback;
  }

  resetIdentityFiles() {
    fs.writeFileSync(this.identityAPath, "", "utf8");
    fs.writeFileSync(this.identityBPath, "", "utf8");
  }

  readExperience() {
    const maxChars = this.config.experienceMaxChars || 3000;
    if (!fs.existsSync(this.experiencePath)) return "";
    const data = fs.readFileSync(this.experiencePath, "utf8");
    if (data.length <= maxChars) return data;
    return data.slice(-maxChars);
  }

  appendExperienceUpdate(debateId, topic, updatesByAgent) {
    const timestamp = formatUtc8();
    const lines = [
      `## [${timestamp}] Debate ${debateId} | Topic: ${topic || "(待定)"}`
    ];

    let hasUpdates = false;
    for (const item of updatesByAgent || []) {
      if (!item || !Array.isArray(item.updates) || !item.updates.length) continue;
      hasUpdates = true;
      lines.push(`- ${item.agentKey}: ${item.updates.join("；")}`);
    }

    if (!hasUpdates) {
      lines.push("- (无经验总结)");
    }

    fs.appendFileSync(this.experiencePath, `${lines.join("\n")}\n\n`, "utf8");
    this.log.appendEvent("experience_update", { topic, updates: updatesByAgent });
  }
}

module.exports = { DebateAgent };
