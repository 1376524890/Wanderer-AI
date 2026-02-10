/* 用途：基于评委评分的轻量策略梯度强化学习（自博弈）。
不负责：模型调用或界面渲染。
输入：评委评分、轮次信息、策略动作。
输出：可持久化的策略权重与训练统计。
关联：src/agent.js, src/prompts.js。
*/

const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso } = require("./utils");

const DEFAULT_TACTICS = [
  { key: "data_anchor", label: "数据锚定", desc: "引用权威数据并说明统计口径" },
  { key: "causal_chain", label: "因果链条", desc: "建立因果机制并说明边界条件" },
  { key: "counter_example", label: "反例对照", desc: "用反例削弱对方过度泛化" },
  { key: "assumption_audit", label: "前提审计", desc: "识别对方隐含前提并进行质疑" },
  { key: "definition_lock", label: "定义锁定", desc: "澄清关键词定义，避免偷换概念" },
  { key: "cross_examine", label: "交叉质询", desc: "指出对方证据/逻辑漏洞并追问" },
  { key: "cost_benefit", label: "成本收益", desc: "量化成本、收益与风险权衡" },
  { key: "case_pivot", label: "案例对照", desc: "用对比案例提升说服力" },
  { key: "mechanism_test", label: "机制检验", desc: "要求对方给出可验证机制或可操作路径" },
  { key: "framework_reframe", label: "框架重述", desc: "重构问题框架，强调己方价值" },
  { key: "priority_tradeoff", label: "价值权衡", desc: "承认代价并给出权衡路径" },
  { key: "steelman_refute", label: "先强后破", desc: "先概括对方最强论点再精准反驳" },
  { key: "synthesis", label: "综合归纳", desc: "总结要点并回扣核心主张" }
];

const FOCUS_DIMS = [
  { key: "logic", label: "逻辑性" },
  { key: "evidence", label: "证据性" },
  { key: "responsiveness", label: "反应度" },
  { key: "expression", label: "表达力" },
  { key: "rule_compliance", label: "规则遵守" }
];

const SUGGESTION_SIGNALS = {
  logic: ["逻辑", "论证", "严密", "链条", "因果"],
  evidence: ["证据", "数据", "案例", "事实", "来源"],
  responsiveness: ["回应", "反驳", "质疑", "针对", "漏洞"],
  expression: ["表达", "语言", "感染力", "节奏", "清晰"],
  rule_compliance: ["规则", "遵守", "越权", "抢答"]
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeProbs(probs, minProb) {
  const keys = Object.keys(probs || {});
  if (!keys.length) return {};
  for (const key of keys) {
    const raw = Number(probs[key]);
    probs[key] = Number.isFinite(raw) ? raw : 0;
  }
  for (const key of keys) {
    probs[key] = Math.max(minProb, probs[key]);
  }
  let sum = keys.reduce((acc, key) => acc + probs[key], 0);
  if (!sum) {
    const uniform = 1 / keys.length;
    for (const key of keys) probs[key] = uniform;
    return probs;
  }
  for (const key of keys) probs[key] = probs[key] / sum;
  return probs;
}

function pickWeighted(keys, probs) {
  const total = keys.reduce((acc, key) => acc + (probs[key] || 0), 0);
  if (total <= 0) return keys[Math.floor(Math.random() * keys.length)];
  let threshold = Math.random() * total;
  for (const key of keys) {
    threshold -= probs[key] || 0;
    if (threshold <= 0) return key;
  }
  return keys[keys.length - 1];
}

function getScoreDetails(scoreObj) {
  if (!scoreObj) return null;
  if (scoreObj.details && typeof scoreObj.details === "object") return scoreObj.details;
  return scoreObj;
}

function computeWeaknesses(myScores, opponentScores) {
  const myDetails = getScoreDetails(myScores);
  const oppDetails = getScoreDetails(opponentScores);
  if (!myDetails || !oppDetails) return [];
  const weaknesses = [];
  for (const dim of FOCUS_DIMS) {
    const myValue = Number(myDetails[dim.key]);
    const oppValue = Number(oppDetails[dim.key]);
    if (!Number.isFinite(myValue) || !Number.isFinite(oppValue)) continue;
    if (oppValue <= 6 || oppValue + 0.3 < myValue) {
      weaknesses.push(`${dim.label}: 对方${oppValue}/10 < 你方${myValue}/10`);
    }
  }
  return weaknesses;
}

function scoreToReward(avg, oppAvg, ruleScore) {
  const quality = (avg - 5) / 5;
  const margin = (avg - oppAvg) / 10;
  const rule = (ruleScore - 5) / 5;
  return 0.6 * quality + 0.3 * margin + 0.1 * rule;
}

function buildTacticMap(tactics) {
  const map = {};
  for (const tactic of tactics) map[tactic.key] = tactic;
  return map;
}

function buildDefaultAgentState(tactics) {
  const uniform = 1 / tactics.length;
  const tactic_probs = {};
  for (const tactic of tactics) tactic_probs[tactic.key] = uniform;
  const focus = {};
  for (const dim of FOCUS_DIMS) focus[dim.key] = 1;
  return {
    step: 0,
    value: 0,
    avg_reward: 0,
    last_reward: 0,
    last_advantage: 0,
    tactic_probs,
    focus,
    last_actions: [],
    last_update: null
  };
}

function mergeTactics(existing, tactics, minProb) {
  const probs = { ...(existing || {}) };
  for (const tactic of tactics) {
    if (!Object.prototype.hasOwnProperty.call(probs, tactic.key)) {
      probs[tactic.key] = minProb;
    }
  }
  return normalizeProbs(probs, minProb);
}

function detectSuggestionSignals(suggestions) {
  const hits = {};
  if (!Array.isArray(suggestions)) return hits;
  for (const dim of Object.keys(SUGGESTION_SIGNALS)) hits[dim] = 0;
  for (const suggestion of suggestions) {
    const text = String(suggestion || "");
    if (!text) continue;
    for (const [dim, keywords] of Object.entries(SUGGESTION_SIGNALS)) {
      if (keywords.some((kw) => text.includes(kw))) hits[dim] += 1;
    }
  }
  return hits;
}

class RlPolicy {
  constructor(config, debateLog, logger) {
    this.config = config || {};
    this.log = debateLog || null;
    this.logger = logger || null;
    this.enabled = this.config.rlEnabled !== false;
    this.tactics = DEFAULT_TACTICS;
    this.tacticMap = buildTacticMap(this.tactics);

    const stateDir = this.config.stateDir || "state";
    this.rlDir = this.config.rlDir || path.join(stateDir, "rl");
    ensureDir(this.rlDir);

    this.policyPath = path.join(this.rlDir, this.config.rlPolicyFile || "rl_policy.json");
    this.metricsPath = path.join(this.rlDir, this.config.rlMetricsFile || "rl_metrics.json");
    this.historyPath = path.join(this.rlDir, this.config.rlHistoryFile || "rl_history.jsonl");

    this.state = this.loadState();
    this.metrics = this.loadMetrics();
    this.currentRound = null;
    this.roundActions = { A: null, B: null };
    this.lastUpdatedRound = null;
  }

  loadState() {
    const minProb = this.config.rlMinProb ?? 0.03;
    if (!fs.existsSync(this.policyPath)) {
      return {
        version: 1,
        updated_at: nowIso(),
        tactics: this.tactics.map(({ key, label, desc }) => ({ key, label, desc })),
        agents: {
          A: buildDefaultAgentState(this.tactics),
          B: buildDefaultAgentState(this.tactics)
        }
      };
    }

    try {
      const raw = fs.readFileSync(this.policyPath, "utf8");
      const data = JSON.parse(raw);
      const agents = data.agents || {};
      const merged = {
        version: data.version || 1,
        updated_at: data.updated_at || nowIso(),
        tactics: this.tactics.map(({ key, label, desc }) => ({ key, label, desc })),
        agents: {
          A: { ...buildDefaultAgentState(this.tactics), ...(agents.A || {}) },
          B: { ...buildDefaultAgentState(this.tactics), ...(agents.B || {}) }
        }
      };
      merged.agents.A.tactic_probs = mergeTactics(merged.agents.A.tactic_probs, this.tactics, minProb);
      merged.agents.B.tactic_probs = mergeTactics(merged.agents.B.tactic_probs, this.tactics, minProb);
      return merged;
    } catch (err) {
      this.logger?.error("rl.state.load_failed", { error: err.message || String(err) });
      return {
        version: 1,
        updated_at: nowIso(),
        tactics: this.tactics.map(({ key, label, desc }) => ({ key, label, desc })),
        agents: {
          A: buildDefaultAgentState(this.tactics),
          B: buildDefaultAgentState(this.tactics)
        }
      };
    }
  }

  loadMetrics() {
    if (!fs.existsSync(this.metricsPath)) {
      return {
        updated_at: nowIso(),
        agents: {
          A: { steps: 0, avg_reward: 0, avg_score: 0 },
          B: { steps: 0, avg_reward: 0, avg_score: 0 }
        }
      };
    }
    try {
      const raw = fs.readFileSync(this.metricsPath, "utf8");
      const data = JSON.parse(raw);
      return {
        updated_at: data.updated_at || nowIso(),
        agents: {
          A: { steps: 0, avg_reward: 0, avg_score: 0, ...(data.agents?.A || {}) },
          B: { steps: 0, avg_reward: 0, avg_score: 0, ...(data.agents?.B || {}) }
        }
      };
    } catch (err) {
      return {
        updated_at: nowIso(),
        agents: {
          A: { steps: 0, avg_reward: 0, avg_score: 0 },
          B: { steps: 0, avg_reward: 0, avg_score: 0 }
        }
      };
    }
  }

  saveState() {
    this.state.updated_at = nowIso();
    try {
      fs.writeFileSync(this.policyPath, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      this.logger?.error("rl.state.save_failed", { error: err.message || String(err) });
    }
  }

  saveMetrics() {
    this.metrics.updated_at = nowIso();
    try {
      fs.writeFileSync(this.metricsPath, JSON.stringify(this.metrics, null, 2), "utf8");
    } catch (err) {
      this.logger?.error("rl.metrics.save_failed", { error: err.message || String(err) });
    }
  }

  appendHistory(entry) {
    try {
      fs.appendFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      this.logger?.error("rl.history.append_failed", { error: err.message || String(err) });
    }
  }

  ensureRound(round) {
    if (this.currentRound !== round) {
      this.currentRound = round;
      this.roundActions = { A: null, B: null };
    }
  }

  selectActions(round, agentKey) {
    if (!this.enabled) return [];
    this.ensureRound(round);
    if (this.roundActions[agentKey]) return this.roundActions[agentKey];

    const agentState = this.state.agents[agentKey];
    if (!agentState) return [];
    const probs = agentState.tactic_probs || {};
    const keys = Object.keys(probs);
    if (!keys.length) return [];

    const count = Math.max(1, Math.min(this.config.rlActionCount || 2, keys.length));
    const actions = [];
    const remaining = [...keys];
    const explore = Math.random() < (this.config.rlExploration ?? 0.1);
    for (let i = 0; i < count; i += 1) {
      const pickKey = explore
        ? remaining[Math.floor(Math.random() * remaining.length)]
        : pickWeighted(remaining, probs);
      actions.push(pickKey);
      const index = remaining.indexOf(pickKey);
      if (index >= 0) remaining.splice(index, 1);
    }
    this.roundActions[agentKey] = actions;
    agentState.last_actions = actions;
    return actions;
  }

  getPromptContext({ agentKey, opponentKey, round, myScores, opponentScores }) {
    if (!this.enabled) return null;
    const actions = this.selectActions(round, agentKey);
    const agentState = this.state.agents[agentKey];
    const focus = agentState?.focus || {};
    const focusSorted = [...FOCUS_DIMS]
      .map((dim) => ({ ...dim, weight: Number(focus[dim.key] || 1) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((dim) => ({
        key: dim.key,
        label: dim.label,
        weight: Number(dim.weight.toFixed(2))
      }));

    const weaknessList = computeWeaknesses(myScores, opponentScores);
    const tacticInfo = actions.map((key) => this.tacticMap[key]).filter(Boolean);
    const opponentSummary = opponentKey ? `对手${opponentKey}` : "对手";

    return {
      actions: tacticInfo,
      focus: focusSorted,
      weaknesses: weaknessList,
      opponentLabel: opponentSummary
    };
  }

  updateFromEvaluation({ evaluation, round, topic, debateId, stageKey, stageTitle, replies }) {
    if (!this.enabled || !evaluation) return;
    if (this.lastUpdatedRound === round) return;
    this.lastUpdatedRound = round;

    const lr = this.config.rlLearningRate ?? 0.12;
    const focusLr = this.config.rlFocusLearningRate ?? 0.08;
    const alpha = this.config.rlBaselineAlpha ?? 0.1;
    const minProb = this.config.rlMinProb ?? 0.03;

    const scores = evaluation.scores || {};
    const averages = evaluation.averages || {};
    const suggestions = evaluation.suggestions || {};

    const identical = replies && replies.A && replies.B
      ? String(replies.A).trim() === String(replies.B).trim()
      : false;
    const duplicatePenalty = identical ? 0.15 : 0;

    const updateAgent = (agentKey, opponentKey) => {
      const agentState = this.state.agents[agentKey];
      if (!agentState) return;

      const avg = Number(averages[agentKey] || 0);
      const oppAvg = Number(averages[opponentKey] || 0);
      const ruleScore = Number(scores?.[agentKey]?.rule_compliance || 5);
      let reward = scoreToReward(avg, oppAvg, ruleScore);
      reward = clamp(reward - duplicatePenalty, -1, 1);

      const baseline = Number(agentState.value || 0);
      const advantage = reward - baseline;
      agentState.value = (1 - alpha) * baseline + alpha * reward;
      agentState.last_reward = reward;
      agentState.last_advantage = advantage;
      agentState.step = Number(agentState.step || 0) + 1;
      agentState.last_update = nowIso();

      const probs = agentState.tactic_probs || {};
      const actions = agentState.last_actions && agentState.last_actions.length
        ? agentState.last_actions
        : this.roundActions[agentKey] || [];
      const keys = Object.keys(probs);
      if (keys.length) {
        for (const key of keys) {
          const chosen = actions.includes(key);
          const direction = chosen ? (1 - probs[key]) : -probs[key] / Math.max(1, keys.length - 1);
          probs[key] = clamp(probs[key] + lr * advantage * direction, minProb, 1);
        }
        agentState.tactic_probs = normalizeProbs(probs, minProb);
      }

      const focus = agentState.focus || {};
      const myDetails = scores?.[agentKey] || {};
      const oppDetails = scores?.[opponentKey] || {};
      const signalHits = detectSuggestionSignals(suggestions[agentKey] || []);

      for (const dim of FOCUS_DIMS) {
        const myValue = Number(myDetails[dim.key] || 5);
        const oppValue = Number(oppDetails[dim.key] || 5);
        const gap = clamp((oppValue - myValue) / 10, -0.2, 0.2);
        const targetGap = clamp((8 - myValue) / 10, -0.1, 0.2);
        const signalBoost = signalHits[dim.key] ? 0.04 * signalHits[dim.key] : 0;
        const delta = focusLr * (gap + targetGap) + signalBoost;
        focus[dim.key] = clamp((focus[dim.key] || 1) + delta, 0.6, 1.8);
      }
      agentState.focus = focus;

      const metrics = this.metrics.agents[agentKey];
      if (metrics) {
        metrics.steps = Number(metrics.steps || 0) + 1;
        metrics.avg_reward = (metrics.avg_reward || 0) * 0.9 + reward * 0.1;
        metrics.avg_score = (metrics.avg_score || 0) * 0.9 + avg * 0.1;
      }
    };

    updateAgent("A", "B");
    updateAgent("B", "A");

    const logPayload = {
      round,
      debate_id: debateId,
      topic,
      stage_key: stageKey,
      stage_title: stageTitle,
      averages,
      duplicate_reply: identical,
      actions: {
        A: this.state.agents.A.last_actions,
        B: this.state.agents.B.last_actions
      },
      rewards: {
        A: this.state.agents.A.last_reward,
        B: this.state.agents.B.last_reward
      }
    };

    this.saveState();
    this.saveMetrics();
    this.appendHistory({ ts: nowIso(), ...logPayload });
    if (this.log?.appendEvent) {
      this.log.appendEvent("rl_update", logPayload);
    }
  }
}

module.exports = { RlPolicy };
