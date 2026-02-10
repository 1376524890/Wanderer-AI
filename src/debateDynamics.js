/* 用途：辩论状态机与动作/意图检测（规则版，可选 LLM 后备）。
不负责：模型调用或奖励累计。
输入：发言内容、上一状态、skills 配置。
输出：状态/动作识别结果与奖励信号。
关联：src/agent.js, src/rlPolicy.js。
*/

const DEFAULT_KEYWORDS = {
  pressure: [
    "是否",
    "是不是",
    "请回答",
    "能否",
    "定义",
    "来源",
    "条件",
    "必须",
    "请说明",
    "请解释"
  ],
  defense: [
    "不能一概而论",
    "复杂",
    "不一定",
    "视情况",
    "综合来看",
    "因地制宜",
    "不好说"
  ],
  deflect: [
    "另一方面",
    "需要更广泛",
    "话题本身",
    "更重要的是",
    "让我们回到"
  ],
  reframe: [
    "换个角度",
    "从另一个角度",
    "重新定义",
    "问题的关键在于",
    "讨论的核心是"
  ],
  concession: [
    "我承认",
    "确实有",
    "部分同意",
    "我们同意"
  ],
  contradiction: [
    "但是我之前说",
    "这与我刚才",
    "自相矛盾",
    "前后不一致"
  ],
  advantage: [
    "你没有回答",
    "你回避了",
    "你没有解释",
    "你的前提错误"
  ],
  yesno: [
    "是",
    "不是",
    "可以",
    "不可以",
    "必须",
    "不必"
  ]
};

const ACTIONS = [
  "AttackClaim",
  "AttackEvidence",
  "ForceClarification",
  "Deflect",
  "ConcedePartial",
  "Reframe",
  "CounterQuestion",
  "SummarizePressure",
  "IntroduceNewClaim"
];

const STATES = {
  Neutral: "Neutral",
  Pressure: "Pressure",
  Defense: "Defense",
  Advantage: "Advantage",
  Collapse: "Collapse"
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function extractKeywords(text, max = 6) {
  if (!text) return [];
  return String(text)
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, max);
}

function countHits(text, keywords) {
  if (!text || !keywords || !keywords.length) return 0;
  let hits = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) hits += 1;
  }
  return hits;
}

function classifyAction({ question, reply, keywords = DEFAULT_KEYWORDS }) {
  const q = String(question || "");
  const r = String(reply || "");
  const qWords = extractKeywords(q);

  if (countHits(r, keywords.concession) > 0) return "ConcedePartial";
  if (countHits(r, keywords.defense) > 0) return "Deflect";
  if (countHits(r, keywords.reframe) > 0) return "Reframe";
  if (countHits(r, keywords.advantage) > 0) return "SummarizePressure";
  if (/[?？]/.test(r) && countHits(r, keywords.pressure) > 0) return "ForceClarification";
  if (countHits(r, keywords.contradiction) > 0) return "Deflect";

  if (q && !countHits(r, qWords) && r.length > 120) return "Deflect";
  if (q && /[?？]/.test(r)) return "CounterQuestion";
  if (countHits(r, ["数据", "证据", "案例", "统计"]) > 0) return "AttackEvidence";
  if (countHits(r, ["我方认为", "核心论点", "主张", "定义"]) > 0) return "IntroduceNewClaim";
  return "AttackClaim";
}

function detectPressure(question, keywords) {
  if (!question) return false;
  if (/[?？]$/.test(question)) return true;
  return countHits(question, keywords.pressure) > 0;
}

function detectDeflect(question, reply, keywords) {
  if (!question || !reply) return false;
  const qWords = extractKeywords(question);
  const hitCount = countHits(reply, qWords);
  const hasDeflect = countHits(reply, keywords.deflect) > 0;
  return (qWords.length >= 2 && hitCount === 0 && reply.length > 80) || hasDeflect;
}

function detectDefense(reply, keywords) {
  return countHits(reply, keywords.defense) > 0;
}

function detectCollapse(reply, keywords) {
  if (!reply) return false;
  if (countHits(reply, keywords.contradiction) > 0) return true;
  if (reply.includes("无法回答") || reply.includes("不知道")) return true;
  return false;
}

function detectAdvantage(reply, keywords) {
  return countHits(reply, keywords.advantage) > 0;
}

function computeNextState({ prevState, question, reply, skills, keywords = DEFAULT_KEYWORDS }) {
  const pressureSkill = clamp(skills.pressure_awareness || 0.6, 0.05, 0.95);
  const commitment = clamp(skills.commitment || 0.6, 0.05, 0.95);
  const recovery = clamp(skills.recovery || 0.6, 0.05, 0.95);

  const pressured = detectPressure(question, keywords);
  const deflect = detectDeflect(question, reply, keywords);
  const defense = detectDefense(reply, keywords);
  const advantage = detectAdvantage(reply, keywords);
  const collapse = detectCollapse(reply, keywords);

  if (collapse && commitment > 0.4) return STATES.Collapse;

  if (advantage) return STATES.Advantage;

  if (pressured && pressureSkill >= 0.45) {
    if (deflect || defense) return STATES.Defense;
    if (recovery > 0.55 && !deflect) return STATES.Advantage;
    return STATES.Pressure;
  }

  if (deflect || defense) return STATES.Defense;
  return prevState || STATES.Neutral;
}

function buildRewardSignals({ prevState, nextState, detectedAction, skills }) {
  const aggression = clamp(skills.aggression || 0.6, 0.05, 0.95);
  const commitment = clamp(skills.commitment || 0.6, 0.05, 0.95);
  const recovery = clamp(skills.recovery || 0.6, 0.05, 0.95);

  const rewards = [];
  const penalties = [];
  const details = {
    deflect: false,
    deflectPenalty: 0,
    collapse: false,
    collapsePenalty: 0,
    pressurePenalty: 0
  };

  const transition = `${prevState || STATES.Neutral}->${nextState || STATES.Neutral}`;
  if (transition === "Neutral->Advantage") rewards.push(1.0 + aggression * 0.2);
  if (transition === "Pressure->Advantage") rewards.push(1.5 + recovery * 0.3);
  if (transition === "Pressure->Defense") {
    const penalty = 0.6 + commitment * 0.4;
    details.pressurePenalty = penalty;
    penalties.push(penalty);
  }
  if (transition === "Defense->Collapse") {
    const penalty = 2.2 + commitment * 0.4;
    details.collapse = true;
    details.collapsePenalty = penalty;
    penalties.push(penalty);
  }

  if (detectedAction === "Deflect") {
    const penalty = 0.8 + commitment * 0.4;
    details.deflect = true;
    details.deflectPenalty = penalty;
    penalties.push(penalty);
  }

  return {
    transition,
    reward: rewards.reduce((a, b) => a + b, 0),
    penalty: penalties.reduce((a, b) => a + b, 0),
    details
  };
}

module.exports = {
  ACTIONS,
  STATES,
  DEFAULT_KEYWORDS,
  classifyAction,
  computeNextState,
  buildRewardSignals
};
