/* 用途：运行双代理辩论主循环，维护身份档案与状态输出。
不负责：渲染监控界面。
输入：配置、对话历史、身份档案。
输出：对话日志、身份更新、状态文件。
关联：src/llmClient.js, src/journal.js, src/prompts.js, src/judge.js。
*/

const fs = require("fs");
const path = require("path");

const { DebateLog } = require("./journal");
const { LlmClient } = require("./llmClient");
const { buildDebatePrompts } = require("./prompts");
const { buildDebateFlow, formatStageLengthGuide, getStageLengthGuide, getStageMaxChars } = require("./workflow");
const { DebateJudge } = require("./judge");
const { loadSkills } = require("./skills");
const { STATES, classifyAction, computeNextState, buildRewardSignals } = require("./debateDynamics");
const { RlPolicy } = require("./rlPolicy");
const {
  ensureDir,
  nowIso,
  readTail,
  truncate,
  safeJsonExtract,
  formatUtc8,
  countExperienceItems,
  compressExperienceSection,
  textSimilarity
} = require("./utils");

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000));
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return false;
  }
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

function trimTailText(text, maxChars) {
  if (!text) return "";
  const raw = String(text).trim();
  if (!maxChars || raw.length <= maxChars) return raw;
  return raw.slice(-maxChars).trim();
}

function isFreeDebateStageKey(stageKey) {
  return typeof stageKey === "string" && stageKey.startsWith("free_");
}

function splitExperienceSections(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current) sections.push(current.join("\n").trim());
      current = [line];
      continue;
    }
    if (!current) continue;
    current.push(line);
  }
  if (current) sections.push(current.join("\n").trim());
  return sections.filter(Boolean);
}

const FALLBACK_TOPICS = [
  "人工智能应否优先用于公共治理而非商业营销？",
  "高校招生应更看重综合素质而非统一考试成绩？",
  "城市应限制私家车出行以改善环境？",
  "短视频平台应承担用户成瘾的主要责任？",
  "企业远程办公应成为常态而非特例？",
  "未成年人应全面禁止网络直播打赏？",
  "应否对生成式 AI 内容强制标注来源？",
  "公共资源分配应优先效率还是公平？"
];

class DebateAgent {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.llm = new LlmClient(config, logger);
    this.judge = new DebateJudge(config, logger);
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

    this.currentEvaluation = null;
    this.currentScores = { A: null, B: null };
    this.cumulativeScores = { A: 0, B: 0 };
    this.evaluatedRounds = 0;
    this.promptInfo = null;
    this.debateStates = { A: STATES.Neutral, B: STATES.Neutral };
    this.lastDetectedActions = { A: null, B: null };
    this.lastRewardSignals = { A: null, B: null };
    this.lastRoundReplies = { A: "", B: "" };

    const experienceDir = config.experienceDir || config.stateDir;
    ensureDir(experienceDir);
    this.experiencePath = path.join(experienceDir, config.experienceFile || "experience.md");

    const archiveDir = config.archiveDir || path.join(config.stateDir, "archives");
    ensureDir(archiveDir);
    this.archiveDir = archiveDir;

    if (config.rlDir) {
      ensureDir(config.rlDir);
    }
    this.rl = new RlPolicy(config, this.log, this.logger);

    this.round = 0;
    this.debateRound = 0;
    this.debateId = 1;
    this.topic = "";
    this.topicHistory = [];
    this.lastReplyAt = null;
    this.tokenStats = this.loadTokenStats();
    this.freeDebateBudget = Number(config.freeDebateTotalChars || 0);
    const configuredFreeMax = Number(config.freeDebateMaxRounds || 0);
    this.freeDebateMaxRounds = configuredFreeMax > 0 ? configuredFreeMax : Number(config.freeDebateRounds || 4);
    this.freeDebateUsage = { A: 0, B: 0 };
    this.debateFlow = buildDebateFlow(this.freeDebateMaxRounds, {
      freeDebateTotalChars: this.freeDebateBudget,
      freeDebateMaxRounds: this.freeDebateMaxRounds
    });
    this.skills = loadSkills(config.skillsPath);
    this.lastRepeatAlerts = { A: null, B: null };

    this.lockPath = path.join(config.stateDir, "agent.lock");
    this.lockCleanupRegistered = false;
    this.lockOwned = this.acquireAgentLock();

    this.ensureIdentityFiles();
    this.loadState();
    this.loadLastTurnReplies();
  }

  loadLastTurnReplies() {
    if (!fs.existsSync(this.lastTurnPath)) return;
    try {
      const raw = fs.readFileSync(this.lastTurnPath, "utf8");
      const data = JSON.parse(raw);
      this.lastRoundReplies = {
        A: data?.agentA?.reply ? String(data.agentA.reply) : this.lastRoundReplies.A,
        B: data?.agentB?.reply ? String(data.agentB.reply) : this.lastRoundReplies.B
      };
    } catch (err) {
      // ignore parse errors
    }
  }

  acquireAgentLock() {
    const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2);
    try {
      const fd = fs.openSync(this.lockPath, "wx");
      fs.writeFileSync(fd, payload, "utf8");
      fs.closeSync(fd);
      this.registerLockCleanup();
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") {
        this.logger?.error("agent.lock.read_failed", { error: err.message });
        return false;
      }
    }

    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
    } catch (err) {
      existing = null;
    }

    if (existing && Number(existing.pid) === Number(process.pid)) {
      this.registerLockCleanup();
      return true;
    }

    if (existing && isProcessAlive(existing.pid)) {
      this.logger?.error("agent.lock.held", { pid: existing.pid });
      return false;
    }

    try {
      fs.writeFileSync(this.lockPath, payload, "utf8");
      this.registerLockCleanup();
      return true;
    } catch (err) {
      this.logger?.error("agent.lock.acquire_failed", { error: err.message });
      return false;
    }
  }

  registerLockCleanup() {
    if (this.lockCleanupRegistered) return;
    this.lockCleanupRegistered = true;
    const cleanup = () => {
      try {
        if (!fs.existsSync(this.lockPath)) return;
        const raw = fs.readFileSync(this.lockPath, "utf8");
        const data = JSON.parse(raw);
        if (Number(data.pid) === Number(process.pid)) {
          fs.unlinkSync(this.lockPath);
        }
      } catch (err) {
        // ignore cleanup errors
      }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
  }

  ensureLockOwnership() {
    this.lockOwned = this.acquireAgentLock();
    return this.lockOwned;
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
      this.topicHistory = Array.isArray(data.topic_history) ? data.topic_history : [];
      this.lastReplyAt = data.last_reply_at || this.lastReplyAt;
      if (data.free_debate_usage && typeof data.free_debate_usage === "object") {
        this.freeDebateUsage = {
          A: Number(data.free_debate_usage.A || 0),
          B: Number(data.free_debate_usage.B || 0)
        };
      }
    } catch (err) {
      // ignore
    }
  }

  async runForever() {
    this.logger?.info("debate.start", { pid: process.pid });
    while (true) {
      if (!this.ensureLockOwnership()) {
        this.writeStatus("agent lock held by another process", 30);
        return;
      }
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

    if (isDebateStart) {
      this.currentEvaluation = null;
      this.currentScores = { A: null, B: null };
      this.cumulativeScores = { A: 0, B: 0 };
      this.evaluatedRounds = 0;
      this.debateStates = { A: STATES.Neutral, B: STATES.Neutral };
      this.lastDetectedActions = { A: null, B: null };
      this.lastRewardSignals = { A: null, B: null };
      this.skills = loadSkills(this.config.skillsPath);
      this.lastRoundReplies = { A: "", B: "" };
      this.freeDebateUsage = { A: 0, B: 0 };
      this.lastRepeatAlerts = { A: null, B: null };
    }

    const conversationContext = readTail(this.conversationPath, this.config.contextMaxChars);

    let roundTopic = this.topic || "";
    if (isDebateStart) {
      roundTopic = await this.resolveDebateTopic(conversationContext, roundTopic, nextRound);
    }
    const allowTopicChange = isDebateStart && !roundTopic;

    const firstAgent = debateStep.order === "B" ? "B" : "A";
    const secondAgent = firstAgent === "A" ? "B" : "A";

    const allowIdentityUpdateAlways = true;

    const firstGuide = this.getDynamicStageGuide(debateStep, firstAgent);
    const secondGuide = this.getDynamicStageGuide(debateStep, secondAgent);
    const firstAgentMaxChars = firstGuide.maxChars;
    const secondAgentMaxChars = secondGuide.maxChars;
    const firstAgentLengthGuide = firstGuide.lengthGuide;
    const secondAgentLengthGuide = secondGuide.lengthGuide;
    const firstAgentBudgetInfo = firstGuide.budgetInfo;
    const secondAgentBudgetInfo = secondGuide.budgetInfo;

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
      lengthGuide: firstAgentLengthGuide,
      role: debateStep.roles[firstAgent],
      task: debateStep.tasks[firstAgent],
      speakerOrder: "first",
      allowIdentityUpdate: allowIdentityUpdateAlways,
      isDebateStart,
      isDebateEnd,
      experience: this.readExperience(),
      conversation: conversationContext,
      evaluation: this.currentEvaluation,
      maxChars: firstAgentMaxChars,
      freeDebateBudget: firstAgentBudgetInfo,
      diversityHint: this.lastRepeatAlerts[firstAgent],
      myScores: this.currentScores[firstAgent],
      opponentScores: this.currentScores[secondAgent]
    });

    if (agentFirstResult.error) {
      const error = `Agent ${firstAgent} failed: ${truncate(agentFirstResult.error, 120)}`;
      this.log.appendSystemEvent("round_retry", error);
      throw new Error(error);
    }

    const topicAfterFirst = this.pickTopic(roundTopic, agentFirstResult.topic, allowTopicChange);
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
      lengthGuide: secondAgentLengthGuide,
      role: debateStep.roles[secondAgent],
      task: debateStep.tasks[secondAgent],
      speakerOrder: "second",
      allowIdentityUpdate: allowIdentityUpdateAlways,
      isDebateStart,
      isDebateEnd,
      experience: this.readExperience(),
      conversation: conversationAfterFirst,
      evaluation: this.currentEvaluation,
      maxChars: secondAgentMaxChars,
      freeDebateBudget: secondAgentBudgetInfo,
      diversityHint: this.lastRepeatAlerts[secondAgent],
      myScores: this.currentScores[secondAgent],
      opponentScores: this.currentScores[firstAgent]
    });

    if (agentSecondResult.error) {
      const error = `Agent ${secondAgent} failed: ${truncate(agentSecondResult.error, 120)}`;
      this.log.appendSystemEvent("round_retry", error);
      throw new Error(error);
    }

    const topicAfterSecond = this.pickTopic(topicAfterFirst, agentSecondResult.topic, allowTopicChange);

    if (isFreeDebateStageKey(debateStep.key)) {
      this.freeDebateUsage[firstAgent] = Number(this.freeDebateUsage[firstAgent] || 0) + (agentFirstResult.reply || "").length;
      this.freeDebateUsage[secondAgent] = Number(this.freeDebateUsage[secondAgent] || 0) + (agentSecondResult.reply || "").length;
    }

    const evaluation = await this.judge.evaluateRound({
      topic: topicAfterSecond,
      stage: debateStep.title,
      stageKey: debateStep.key,
      stageRule: debateStep.rule,
      replyA: agentFirstResult.reply,
      replyB: agentSecondResult.reply,
      speakerA: firstAgent,
      speakerB: secondAgent,
      round: nextRound
    });

    const opponentKeyFor = (key) => (key === "A" ? "B" : "A");
    const prevOpponentReply = (key) => (this.lastRoundReplies ? this.lastRoundReplies[opponentKeyFor(key)] : "");

    const roundContext = {
      [firstAgent]: {
        question: prevOpponentReply(firstAgent),
        reply: agentFirstResult.reply
      },
      [secondAgent]: {
        question: agentFirstResult.reply,
        reply: agentSecondResult.reply
      }
    };

    const detectedActions = {
      A: classifyAction(roundContext.A || {}),
      B: classifyAction(roundContext.B || {})
    };

    const prevStates = { ...this.debateStates };
    const nextStates = {
      A: computeNextState({
        prevState: prevStates.A,
        question: roundContext.A.question,
        reply: roundContext.A.reply,
        skills: this.skills.A
      }),
      B: computeNextState({
        prevState: prevStates.B,
        question: roundContext.B.question,
        reply: roundContext.B.reply,
        skills: this.skills.B
      })
    };
    this.debateStates = nextStates;

    const rewardSignals = {
      A: buildRewardSignals({
        prevState: prevStates.A,
        nextState: nextStates.A,
        detectedAction: detectedActions.A,
        skills: this.skills.A
      }),
      B: buildRewardSignals({
        prevState: prevStates.B,
        nextState: nextStates.B,
        detectedAction: detectedActions.B,
        skills: this.skills.B
      })
    };
    this.lastDetectedActions = detectedActions;
    this.lastRewardSignals = rewardSignals;

    const repliesByAgent = {
      A: agentFirstResult.agentKey === "A" ? agentFirstResult.reply : agentSecondResult.reply,
      B: agentFirstResult.agentKey === "B" ? agentFirstResult.reply : agentSecondResult.reply
    };
    const repeatThreshold = Number(this.config.repeatSimThreshold || 0.92);
    const repeatPenalty = Number(this.config.repeatPenalty || 0.35);
    const sameRoundPenalty = Number(this.config.repeatSameRoundPenalty || 0.4);
    const simSameRound = textSimilarity(repliesByAgent.A, repliesByAgent.B);
    const simSelfA = textSimilarity(repliesByAgent.A, this.lastRoundReplies.A);
    const simSelfB = textSimilarity(repliesByAgent.B, this.lastRoundReplies.B);
    const simOppA = textSimilarity(repliesByAgent.A, this.lastRoundReplies.B);
    const simOppB = textSimilarity(repliesByAgent.B, this.lastRoundReplies.A);

    const buildRepeatAlert = (parts) => parts.length ? `${parts.join("；")}。请更换论据/结构，避免复述。` : null;

    const repeatAlerts = { A: null, B: null };
    const applyRepeatPenalty = (agentKey, selfSim, oppSim) => {
      let penalty = 0;
      const hints = [];
      if (selfSim >= repeatThreshold) {
        penalty = Math.max(penalty, repeatPenalty);
        hints.push("与你上一轮高度重复");
      }
      if (oppSim >= repeatThreshold) {
        penalty = Math.max(penalty, repeatPenalty * 0.6);
        hints.push("与对方上一轮高度相似");
      }
      if (simSameRound >= repeatThreshold) {
        penalty = Math.max(penalty, sameRoundPenalty);
        hints.push("与对方本轮高度相似");
      }
      if (penalty > 0 && rewardSignals[agentKey]) {
        rewardSignals[agentKey].penalty += penalty;
        rewardSignals[agentKey].details.repeat = true;
        rewardSignals[agentKey].details.repeatPenalty = (rewardSignals[agentKey].details.repeatPenalty || 0) + penalty;
        repeatAlerts[agentKey] = buildRepeatAlert(hints);
      }
    };

    applyRepeatPenalty("A", simSelfA, simOppA);
    applyRepeatPenalty("B", simSelfB, simOppB);
    this.lastRepeatAlerts = repeatAlerts;

    if (evaluation) {
      this.currentEvaluation = evaluation;
      this.currentScores = {
        A: {
          average: evaluation.averages.A,
          details: evaluation.scores.A
        },
        B: {
          average: evaluation.averages.B,
          details: evaluation.scores.B
        }
      };
      this.cumulativeScores.A += evaluation.averages.A;
      this.cumulativeScores.B += evaluation.averages.B;
      this.evaluatedRounds += 1;
    } else {
      this.logger?.warn("agent.round.skip_score", {
        round: nextRound,
        reason: "评委LLM不可用，跳过本轮评分"
      });
      this.log.appendSystemEvent("round_score_skipped", "评委LLM不可用，跳过本轮评分");
    }

    if (evaluation && this.rl) {
      const replies = {
        A: agentFirstResult.agentKey === "A" ? agentFirstResult.reply : agentSecondResult.reply,
        B: agentFirstResult.agentKey === "B" ? agentFirstResult.reply : agentSecondResult.reply
      };
      this.rl.updateFromEvaluation({
        evaluation,
        round: nextRound,
        debateId: currentDebateId,
        topic: topicAfterSecond || topicAfterFirst || roundTopic,
        stageKey: debateStep.key,
        stageTitle: debateStep.title,
        replies,
        stateInfo: {
          prev: prevStates,
          next: nextStates
        },
        detectedActions,
        rewardSignals,
        curriculumPhase: this.config.curriculumPhase
      });
    }

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

    this.log.appendRoundEvaluation(nextRound, evaluation);

    const resultsByAgent = {
      [agentFirstResult.agentKey]: agentFirstResult,
      [agentSecondResult.agentKey]: agentSecondResult
    };

    this.lastRoundReplies = {
      A: resultsByAgent.A ? resultsByAgent.A.reply : this.lastRoundReplies.A,
      B: resultsByAgent.B ? resultsByAgent.B.reply : this.lastRoundReplies.B
    };

    this.applyIdentityUpdate("A", resultsByAgent.A ? resultsByAgent.A.planUpdate : []);
    this.applyIdentityUpdate("B", resultsByAgent.B ? resultsByAgent.B.planUpdate : []);

    this.round = nextRound;
    const resolvedTopic = topicAfterSecond || topicAfterFirst || roundTopic;
    if (isDebateStart && resolvedTopic) {
      this.recordTopic(resolvedTopic);
    }
    this.topic = resolvedTopic;
    let nextDebateRoundValue = isDebateEnd ? 0 : nextDebateRound;
    const freeBudgetReached = isFreeDebateStageKey(debateStep.key)
      && this.freeDebateBudget
      && this.freeDebateUsage.A >= this.freeDebateBudget
      && this.freeDebateUsage.B >= this.freeDebateBudget;
    if (!isDebateEnd && freeBudgetReached) {
      nextDebateRoundValue = Math.max(0, this.debateFlow.length - 1);
      this.log.appendSystemEvent(
        "free_debate_budget_reached",
        `Free debate budget reached at round ${nextRound}, jump to closing next.`
      );
    }
    this.debateRound = nextDebateRoundValue;

    const lastTurn = {
      round: nextRound,
      debate_round: nextDebateRound,
      debate_id: currentDebateId,
      stage: debateStep.title,
      topic: resolvedTopic,
      agentA: resultsByAgent.A,
      agentB: resultsByAgent.B,
      evaluation: this.currentEvaluation,
      debate_states: nextStates,
      detected_actions: detectedActions,
      reward_signals: rewardSignals,
      free_debate_usage: { ...this.freeDebateUsage },
      repeat_alerts: this.lastRepeatAlerts,
      cumulativeScores: { ...this.cumulativeScores },
      avgScores: {
        A: this.cumulativeScores.A / this.evaluatedRounds,
        B: this.cumulativeScores.B / this.evaluatedRounds
      }
    };
    fs.writeFileSync(this.lastTurnPath, JSON.stringify(lastTurn, null, 2), "utf8");

    if (isDebateEnd) {
      const debateHistory = this.readFullConversation();
      const finalEvaluation = await this.judge.evaluateDebate(debateHistory, resolvedTopic);
      if (finalEvaluation) {
        this.log.appendFinalEvaluation(currentDebateId, finalEvaluation);
      } else {
        this.logger?.warn("agent.debate.skip_score", {
          debate_id: currentDebateId,
          reason: "评委LLM不可用，跳过整场评分"
        });
        this.log.appendSystemEvent("debate_score_skipped", "评委LLM不可用，跳过整场评分");
      }

      this.appendExperienceUpdate(currentDebateId, resolvedTopic, [
        { agentKey: "A", updates: lastTurn.agentA.experienceUpdate },
        { agentKey: "B", updates: lastTurn.agentB.experienceUpdate }
      ]);
      this.resetIdentityFiles();
      this.topic = "";
      this.log.appendSystemEvent("debate_end", `Debate ${currentDebateId} completed. Winner: ${finalEvaluation.winner}`);
      this.debateId += 1;
    }

    return { sleepSeconds: Math.max(1, this.config.loopSleepSeconds) };
  }

  pickTopic(current, proposed, allowChange = true) {
    const trimmed = String(proposed || "").trim();
    if (!trimmed) return current;
    if (!allowChange) return current;
    if (this.isTopicUsed(trimmed)) return current;
    return trimmed;
  }

  isTopicUsed(topic) {
    const trimmed = String(topic || "").trim();
    if (!trimmed) return false;
    return this.topicHistory.includes(trimmed);
  }

  recordTopic(topic) {
    const trimmed = String(topic || "").trim();
    if (!trimmed) return;
    if (!this.topicHistory.includes(trimmed)) {
      this.topicHistory.push(trimmed);
    }
  }

  pickFallbackTopic() {
    for (const candidate of FALLBACK_TOPICS) {
      if (!this.isTopicUsed(candidate)) return candidate;
    }
    const base = "公共政策应更强调公平还是效率？";
    let candidate = base;
    let index = 1;
    while (this.isTopicUsed(candidate)) {
      candidate = `${base}（备选${index}）`;
      index += 1;
    }
    return candidate;
  }

  async resolveDebateTopic(conversation, currentTopic, round) {
    const trimmed = String(currentTopic || "").trim();
    if (trimmed && !this.isTopicUsed(trimmed)) {
      return trimmed;
    }
    const generated = await this.generateNewTopic(conversation, trimmed, round);
    if (generated && !this.isTopicUsed(generated)) {
      return generated;
    }
    return this.pickFallbackTopic();
  }

  async generateNewTopic(conversation, currentTopic, round) {
    if (!conversation || conversation.trim() === "(无)") return "";

    const systemPrompt = "你是一个辩论题目生成助手。分析给定的对话内容，找出核心分歧点，并基于此生成一个新的辩论题目。要求：1）题目必须可辩论，不能是事实陈述；2）题目不能与历史题目相同；3）题目应该引发对立观点；4）题目简洁明确，10-30字。输出严格JSON格式：{\"disagreement\":\"核心分歧点\",\"new_topic\":\"新辩论题目\"}";

    const historyText = this.topicHistory.length
      ? this.topicHistory.slice(-20).join("；")
      : "(无)";
    const userPrompt = [
      `当前轮次：${round}`,
      `当前题目：${currentTopic || "(未设定)"}`,
      `历史题目：${historyText}`,
      "【对话内容】",
      conversation
    ].join("\n");

    try {
      const result = await this.llm.chat(systemPrompt, userPrompt, { model: this.config.vllmModel });
      const json = safeJsonExtract(result.content || "");
      if (json && json.new_topic && json.new_topic.trim()) {
        const newTopic = json.new_topic.trim();
        if (!this.topicHistory.includes(newTopic)) {
          this.log.appendSystemEvent("topic_generated", `Round ${round}: ${newTopic} (分歧点: ${json.disagreement || "未明确"})`);
          return newTopic;
        }
      }
    } catch (err) {
      this.logger?.error("topic.generate.failed", { error: err?.message || String(err) });
    }

    return "";
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
    conversation,
    evaluation,
    maxChars,
    freeDebateBudget,
    diversityHint,
    myScores,
    opponentScores
  }) {
    const identityRaw = this.readIdentity(identityPath);
    const opponentKey = agentKey === "A" ? "B" : "A";
    const rlContext = this.rl?.getPromptContext({
      agentKey,
      opponentKey,
      round,
      myScores,
      opponentScores
    });

    const warnChars = Number(this.config.promptWarnChars || 12000);
    const promptMaxChars = Number(this.config.promptMaxChars || 15000);
    let conversationText = trimTailText(conversation || "", this.config.contextMaxChars);
    let experienceText = trimTailText(experience || "", this.config.experienceMaxChars);
    let identityText = trimTailText(identityRaw || "", this.config.identityMaxChars);

    const maxTokens = this.computeMaxTokens(maxChars);
    const buildPrompt = () => buildDebatePrompts({
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
      identity: identityText,
      allowIdentityUpdate,
      experience: experienceText,
      isDebateStart,
      isDebateEnd,
      conversation: conversationText,
      evaluation,
      myScores,
      opponentScores,
      rlContext,
      maxTokens,
      diversityHint,
      freeDebateBudget
    });

    let { systemPrompt, userPrompt } = buildPrompt();
    let promptChars = systemPrompt.length + userPrompt.length;
    let trimmed = false;

    let guard = 0;
    while (promptChars > promptMaxChars && guard < 6) {
      guard += 1;
      trimmed = true;
      const overflow = promptChars - promptMaxChars;
      if (conversationText.length > 420) {
        const reduce = Math.min(conversationText.length - 420, Math.ceil(overflow * 0.7));
        conversationText = trimTailText(conversationText, Math.max(420, conversationText.length - reduce));
      } else if (experienceText.length > 420) {
        const reduce = Math.min(experienceText.length - 420, Math.ceil(overflow * 0.5));
        experienceText = trimTailText(experienceText, Math.max(420, experienceText.length - reduce));
      } else if (identityText.length > 320) {
        const reduce = Math.min(identityText.length - 320, Math.ceil(overflow * 0.3));
        identityText = trimTailText(identityText, Math.max(320, identityText.length - reduce));
      } else {
        break;
      }
      ({ systemPrompt, userPrompt } = buildPrompt());
      promptChars = systemPrompt.length + userPrompt.length;
    }

    if (promptChars > warnChars) {
      this.logger?.warn("prompt.too_long", {
        agent: agentKey,
        promptChars,
        warnChars,
        maxChars: promptMaxChars,
        trimmed
      });
      this.log.appendSystemEvent("prompt_warn", `Agent ${agentKey} prompt chars ${promptChars} (warn ${warnChars}, max ${promptMaxChars})`);
    }

    this.promptInfo = {
      agent: agentKey,
      total_chars: promptChars,
      system_chars: systemPrompt.length,
      user_chars: userPrompt.length,
      warn_chars: warnChars,
      max_chars: promptMaxChars,
      trimmed,
      at: nowIso()
    };

    let rawResponse = "";
    let llmUsage = null;
    let llmError = "";
    const model = this.getModelForAgent(agentKey);

    try {
      const result = await this.llm.chat(systemPrompt, userPrompt, { model, maxTokens });
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
    let reply = parsed.reply || (llmError ? `(API error: ${truncate(llmError, 120)})` : "(无回复)");
    
    if (maxChars && maxChars > 0 && reply.length > maxChars) {
      reply = reply.slice(0, maxChars);
    }
    
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
      return { reply: this.stripThinkTags(text), topic: "", planUpdate: [], experienceUpdate: [] };
    }

    const reply = this.stripThinkTags(String(json.reply || json.response || ""));
    const topic = String(json.topic || "").trim();
    const update = json.plan_update || json.planUpdate || json.identity_update || json.identityUpdate || [];
    const planUpdate = this.normalizeUpdateList(update);
    const expUpdate = json.experience_update || json.experienceUpdate || [];
    const experienceUpdate = this.normalizeList(expUpdate);
    return { reply, topic, planUpdate, experienceUpdate };
  }

  stripThinkTags(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[\s\S]*?<\/think>/gi, '').trim();
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
      const raw = fs.readFileSync(identityPath, "utf8");
      return trimTailText(raw, this.config.identityMaxChars);
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
    const avgScoreA = this.evaluatedRounds > 0 ? this.cumulativeScores.A / this.evaluatedRounds : null;
    const avgScoreB = this.evaluatedRounds > 0 ? this.cumulativeScores.B / this.evaluatedRounds : null;
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
      topic_history: this.topicHistory.slice(-50),
      last_reply_at: this.lastReplyAt || nowIso(),
      sleep_seconds: sleepSeconds,
      token_stats: this.tokenStats,
      api_status: llmStatus,
      prompt_info: this.promptInfo,
      curriculum_phase: this.config.curriculumPhase,
      free_debate_budget: this.freeDebateBudget || null,
      free_debate_usage: this.freeDebateUsage,
      free_debate_remaining: this.freeDebateBudget
        ? {
          A: Math.max(0, this.freeDebateBudget - (this.freeDebateUsage.A || 0)),
          B: Math.max(0, this.freeDebateBudget - (this.freeDebateUsage.B || 0))
        }
        : null,
      repeat_alerts: this.lastRepeatAlerts,
      reward_mix: {
        debate_weight: this.config.stateRewardWeight ?? 0.8,
        judge_weight: 1 - (this.config.stateRewardWeight ?? 0.8)
      },
      skills: this.skills,
      rl_status: this.rl?.getStatusSnapshot ? this.rl.getStatusSnapshot() : null,
      judge: {
        evaluated_rounds: this.evaluatedRounds,
        current_evaluation: this.currentEvaluation,
        current_scores: this.currentScores,
        cumulative_scores: this.cumulativeScores,
        debate_states: this.debateStates,
        detected_actions: this.lastDetectedActions,
        reward_signals: this.lastRewardSignals,
        average_scores: {
          A: avgScoreA,
          B: avgScoreB
        },
        overall_winner: avgScoreA && avgScoreB
          ? (avgScoreA > avgScoreB ? "A" : avgScoreA < avgScoreB ? "B" : "tie")
          : null
      }
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

  getFreeDebateBudgetInfo(agentKey) {
    if (!this.freeDebateBudget || this.freeDebateBudget <= 0) return null;
    const used = Number(this.freeDebateUsage?.[agentKey] || 0);
    const remaining = Math.max(0, this.freeDebateBudget - used);
    const note = remaining <= 0 ? "预算已用尽，建议以简短收束为主" : "";
    return { total: this.freeDebateBudget, used, remaining, note };
  }

  getDynamicStageGuide(stage, agentKey) {
    const baseGuide = getStageLengthGuide(stage, agentKey);
    const baseMaxChars = getStageMaxChars(stage, agentKey);
    if (!stage || !isFreeDebateStageKey(stage.key) || !this.freeDebateBudget) {
      return { lengthGuide: baseGuide, maxChars: baseMaxChars, budgetInfo: null };
    }

    const budgetInfo = this.getFreeDebateBudgetInfo(agentKey);
    const minFloor = Math.max(40, Number(this.config.freeDebateMinChars || 120));
    const remaining = budgetInfo ? budgetInfo.remaining : 0;
    let maxChars = baseMaxChars || minFloor;
    if (remaining > 0) {
      maxChars = Math.min(maxChars, remaining);
    } else if (maxChars < minFloor) {
      maxChars = minFloor;
    }

    if (maxChars < 40) maxChars = 40;
    let minChars = Math.floor(maxChars * 0.8);
    if (minChars < 30) minChars = Math.floor(maxChars * 0.6);
    if (minChars < 20) minChars = Math.min(20, maxChars);
    if (minChars > maxChars) minChars = Math.max(10, Math.floor(maxChars * 0.5));

    const lengthGuide = {
      min: minChars,
      max: maxChars,
      hint: remaining > 0 ? "自由辩预算控制" : "预算已用尽，尽量简短",
      unit: "字"
    };

    return { lengthGuide, maxChars, budgetInfo };
  }

  computeMaxTokens(maxChars) {
    const base = Number(this.config.maxTokens || 0);
    const minTokens = Number(this.config.minTokens || 64);
    const ratio = Number(this.config.tokensPerChar || 1.2);
    if (maxChars && maxChars > 0 && Number.isFinite(ratio)) {
      const estimate = Math.ceil(maxChars * ratio);
      const clamped = Math.max(minTokens, estimate);
      return base > 0 ? Math.min(base, clamped) : clamped;
    }
    return base > 0 ? base : undefined;
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

  readFullConversation() {
    if (!fs.existsSync(this.conversationPath)) return "";
    try {
      return fs.readFileSync(this.conversationPath, "utf8");
    } catch (err) {
      return "";
    }
  }

  readExperience() {
    const maxChars = this.config.experienceMaxChars || 5000;
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

    const avgScoreA = this.cumulativeScores.A / this.evaluatedRounds;
    const avgScoreB = this.cumulativeScores.B / this.evaluatedRounds;

    const rlSection = [
      `\n### 强化学习统计`,
      `- 评估轮数: ${this.evaluatedRounds}`,
      `- 正方平均分: ${avgScoreA.toFixed(2)}/10`,
      `- 反方平均分: ${avgScoreB.toFixed(2)}/10`,
      `- 累计总分: 正方 ${this.cumulativeScores.A.toFixed(2)} | 反方 ${this.cumulativeScores.B.toFixed(2)}`,
      `- 表现评估: ${avgScoreA > avgScoreB ? "正方领先" : avgScoreB > avgScoreA ? "反方领先" : "势均力敌"}`,
      ""
    ];

    fs.appendFileSync(this.experiencePath, `${rlSection.join("\n")}\n\n`, "utf8");

    this.compressExperienceIfNeeded();
  }

  compressExperienceIfNeeded() {
    const threshold = Number(this.config.experienceCompressEvery || 0);
    if (!threshold) return;
    if (!fs.existsSync(this.experiencePath)) return;

    const raw = fs.readFileSync(this.experiencePath, "utf8");
    const itemCount = countExperienceItems(raw);
    if (itemCount < threshold) return;

    const sections = splitExperienceSections(raw);
    const keepCount = Math.max(1, Math.min(2, sections.length));
    const kept = sections.slice(-keepCount).join("\n\n");
    const summary = compressExperienceSection(
      raw,
      this.config.experienceCompressMaxItems || 12,
      1200
    );
    const stamp = formatUtc8();
    const payload = [
      `## [${stamp}] 经验压缩（自动）`,
      summary || "（压缩失败，保留最近记录）",
      "",
      kept
    ]
      .filter(Boolean)
      .join("\n");

    fs.writeFileSync(this.experiencePath, `${payload}\n\n`, "utf8");
    this.log.appendEvent("experience_compressed", { itemCount, keptSections: keepCount });
  }
}

module.exports = { DebateAgent };
