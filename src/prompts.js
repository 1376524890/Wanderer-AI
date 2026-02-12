/* 用途：构建双代理辩论提示词（人类辩论赛流程）。
不负责：模型调用或状态管理。
输入：身份档案、主题、回合信息、阶段信息。
输出：system/user 提示词字符串。
关联：src/agent.js。
*/

const AGENTS = {
  A: {
    name: "正方",
    role: "正方团队",
    style: "理性、结构化、强调证据、逻辑与论证链，擅长抓住对方漏洞并给出新见解"
  },
  B: {
    name: "反方",
    role: "反方团队",
    style: "批判、质疑、寻找漏洞并提出反例与替代解释，善于揭示隐含前提与边界条件"
  }
};

const { formatLengthGuide } = require("./workflow");

const BRAINSTORM_LENSES = [
  { key: "stakeholder_shift", label: "利益相关者切换", desc: "从政府/企业/公众/弱势群体视角重述影响" },
  { key: "time_split", label: "时间尺度对比", desc: "区分短期/长期/转折点效果与风险" },
  { key: "boundary_case", label: "边界/极端情形", desc: "用极端或边界案例测试对方主张" },
  { key: "mechanism_chain", label: "机制链推演", desc: "给出因果链并提出可检验预测" },
  { key: "metric_oper", label: "指标操作化", desc: "定义指标口径，提出可验证衡量方式" },
  { key: "policy_toolkit", label: "政策工具组合", desc: "从法制/经济/技术/组织多工具权衡" }
];

const TECHNIQUE_LIBRARY = [
  "定义锁定（澄清概念，避免偷换）",
  "前提审计（指出隐含假设）",
  "反例对照（用反例限制泛化）",
  "成本收益（量化权衡与机会成本）",
  "机制检验（要求可验证机制）",
  "分配效应（谁得利/谁受损）",
  "可行性校验（执行路径与约束）",
  "反事实推演（如果相反成立会怎样）"
];

const BRAINSTORM_STEPS = [
  "发散：先列出3个不同角度/假设/证据路径（不在 reply 中明示）。",
  "选择：从中挑1个与对方观点最冲突且可检验的角度。",
  "落地：给出清晰论点 + 边界条件 + 可检验例证/数据。",
  "收束：回扣本轮任务与对抗点，避免铺陈过多。"
];

const TIME_CHAR_MAP = [
  "1分钟≈300字",
  "30秒≈150字",
  "2分钟≈600字",
  "3分钟≈900字"
];

function pickBrainstormCue(round, agentKey) {
  const indexSeed = (Number(round || 0) + (agentKey === "B" ? 3 : 0)) % BRAINSTORM_LENSES.length;
  return BRAINSTORM_LENSES[indexSeed];
}

function buildDebatePrompts({
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
  topic,
  identity,
  experience,
  allowIdentityUpdate,
  isDebateStart,
  isDebateEnd,
  conversation,
  evaluation,
  myScores,
  opponentScores,
  rlContext,
  maxTokens,
  diversityHint,
  freeDebateBudget
}) {
  const agent = AGENTS[agentKey] || AGENTS.A;
  const identityText = identity && identity.trim() ? identity.trim() : "(空)";
  const experienceText = experience && experience.trim() ? experience.trim() : "(空)";
  const topicText = topic && topic.trim() ? topic.trim() : "未设定";
  const allowUpdateText = allowIdentityUpdate ? "允许" : "不允许";
  const orderText = speakerOrder === "first" ? "先手" : "后手";
  const debateStartText = isDebateStart ? "是" : "否";
  const debateEndText = isDebateEnd ? "是" : "否";
  const lengthGuideText = lengthGuide ? formatLengthGuide(lengthGuide) : "按阶段规则控制";
  const maxTokenText = Number.isFinite(maxTokens) ? maxTokens : 4096;
  const brainstormCue = pickBrainstormCue(round, agentKey);

  let evaluationSection = "";
  if (evaluation) {
    const myAvg = (myScores && myScores.average) ? myScores.average.toFixed(2) : evaluation.averages[agentKey]?.toFixed(2) || "N/A";
    const opponentKey = agentKey === "A" ? "B" : "A";
    const opponentAvg = (opponentScores && opponentScores.average) ? opponentScores.average.toFixed(2) : evaluation.averages[opponentKey]?.toFixed(2) || "N/A";
    const myDetails = (myScores && myScores.details) ? myScores.details : evaluation.scores[agentKey];
    const opponentDetails = (opponentScores && opponentScores.details) ? opponentScores.details : evaluation.scores[opponentKey];
    const mySuggestions = evaluation.suggestions[agentKey] || [];
    const myCoaching = evaluation.coaching?.[agentKey] || [];
    const opponentHighlights = evaluation.highlights[opponentKey] || [];
    const combinedSuggestions = [...new Set([...myCoaching, ...mySuggestions])];

    evaluationSection = `
【⚖️ 评委评分（上一轮）】
【${agent.name}得分】总分: ${myAvg}/10
- 逻辑性: ${myDetails?.logic || 5}/10
- 证据性: ${myDetails?.evidence || 5}/10
- 反应度: ${myDetails?.responsiveness || 5}/10
- 表达力: ${myDetails?.expression || 5}/10
- 规则遵守: ${myDetails?.rule_compliance || 5}/10

【${agentKey === "A" ? "反方" : "正方"}得分】总分: ${opponentAvg}/10

【评委对你的建议】
${combinedSuggestions.length ? combinedSuggestions.map(s => `- ${s}`).join("\n") : "- (无)"}

【本轮核心对抗点】
${evaluation.clash_summary ? `- ${evaluation.clash_summary}` : "- (未提供)"}

【对方亮点】
${opponentHighlights.map(h => `- ${h}`).join("\n")}

【本轮胜方】${evaluation.round_winner === agentKey ? "✅ 你方获胜" : evaluation.round_winner === "tie" ? "🤝 平局" : "❌ 对方获胜"}
`;
  }

  const systemPrompt = [
    "你是模拟人类辩论赛的智能体，只输出严格 JSON。",
    `你的阵营：${agent.name}（${agent.role}），风格：${agent.style}。`,
    "必须基于你的 plan 文档行事；experience 文档是双方共享的经验准则。",
    "只可修改自己的 plan 文档，不得改动对方规划。",
    "输出字段：reply, topic, plan_update, experience_update。",
    "reply 为本轮发言；topic 为当前主题（如为空则必须给出）。",
    "plan_update 为数组，支持 add/del/change 操作；请在每轮辩论后更新规划，细化应对策略。",
    "experience_update 仅在整场辩论结束时填写 1-3 条可执行经验总结，否则必须为空数组。",
    "可见性约束：plan/experience 仅供内部参考，不得在 reply 中直接复述或泄露。",
    "强化学习策略仅供内部参考，不得在 reply 中显式提及策略、权重、奖励或训练细节。",
    "必须体现互动性：至少回应/概括对方一个核心观点，并给出针对性反驳或追问。",
    "必须提供一个独特洞见（新角度、边界条件或可检验假设），避免空泛套话。",
    "严禁与对方或上一轮发言高度重复，不可大段复述对方措辞。",
    "采用先发散后收敛的头脑风暴流程：先内部列出备选角度，再择优输出。",
    "禁止输出多余文本、禁止 Markdown 代码块。",
    evaluation ? "你必须根据评委评分调整策略，强化优势，改进不足。" : ""
  ].join(" ");

  const rlSection = rlContext ? [
    "【强化学习策略】",
    rlContext.intent ? `本轮意图（必须体现在发言中，不要在 reply 中显式说明）：${rlContext.intent.label} - ${rlContext.intent.desc}` : "本轮意图：（无）",
    "策略动作（必须落实到本轮发言）：",
    ...((rlContext.actions || []).length
      ? rlContext.actions.map((item) => `- ${item.label}: ${item.desc}`)
      : ["- (无)"]),
    "",
    "训练焦点（优先级从高到低）：",
    ...((rlContext.focus || []).length
      ? rlContext.focus.map((item) => `- ${item.label} (权重 ${item.weight})`)
      : ["- (无)"]),
    "",
    `${rlContext.opponentLabel || "对手"}弱点（优先攻击）：`,
    ...((rlContext.weaknesses || []).length
      ? rlContext.weaknesses.map((item) => `- ${item}`)
      : ["- (未发现明显弱点)"]),
    ""
  ].join("\n") : "";

  const brainstormSection = [
    "【创意结构（每轮择1执行，不在 reply 中标注）】",
    ...BRAINSTORM_LENSES.map((item) => `- ${item.label}: ${item.desc}`),
    `本轮建议：${brainstormCue.label} - ${brainstormCue.desc}`,
    ""
  ].join("\n");

  const techniqueSection = [
    "【技巧库（可选，避免与上轮重复）】",
    ...TECHNIQUE_LIBRARY.map((item) => `- ${item}`),
    ""
  ].join("\n");

  const brainstormStepsSection = [
    "【头脑风暴流程（内部执行）】",
    ...BRAINSTORM_STEPS.map((item) => `- ${item}`),
    ""
  ].join("\n");

  const timeMapSection = [
    "【时间-字数对应】",
    ...TIME_CHAR_MAP.map((item) => `- ${item}`),
    "若规则含分钟，请按以上对应换算成字数执行。",
    ""
  ].join("\n");

  const budgetSection = freeDebateBudget ? [
    "【自由辩预算】",
    `每方总预算：${freeDebateBudget.total}字`,
    `你方已用：${freeDebateBudget.used}字`,
    `你方剩余：${freeDebateBudget.remaining}字`,
    freeDebateBudget.note ? `提示：${freeDebateBudget.note}` : "",
    ""
  ].filter(Boolean).join("\n") : "";

  const diversitySection = diversityHint ? [
    "【去重提醒】",
    diversityHint,
    ""
  ].join("\n") : "";

  const userPrompt = [
    `当前全局回合：${round}`,
    `当前辩论场次：${debateId ?? "-"}`,
    `辩论轮次：${debateRound ?? "-"} / ${debateTotalRounds ?? "-"}`,
    `阶段标识：${stageKey || "-"}`,
    `阶段：${stageTitle || "-"}`,
    `阶段规则：${stageRule || "-"}`,
    `字数建议：${lengthGuideText}`,
    `你的角色：${role || "-"}`,
    `发言顺序：${orderText}`,
    `本轮任务：${task || "-"}`,
    `是否为新辩题开场：${debateStartText}`,
    `是否为整场结束：${debateEndText}`,
    `当前主题：${topicText}`,
    "",
    evaluationSection,
    "",
    rlSection,
    brainstormSection,
    techniqueSection,
    brainstormStepsSection,
    timeMapSection,
    budgetSection,
    diversitySection,
    "【字数控制】",
    "必须遵循字数建议范围，超出需在下一轮自行压缩。",
    `系统已配置最大token限制为${maxTokenText}，请确保回复不会超出此限制。`,
    evaluation ? "【⚠️ 重要提醒】请根据评委评分和建议，在plan_update中明确改进措施。" : "",
    "",
    "【互动性要求】",
    "1) 回应对方最新观点，明确指出1处漏洞或假设。",
    "2) 给出1条可检验的论证或案例/数据（允许假设场景，但要说明边界）。",
    "3) 若为提问角色，只提出1个精确问题；若为回答角色，只回答该问题。",
    "",
    "【共享 experience 文档】",
    experienceText,
    "",
    "【你的 plan 文档】",
    identityText,
    "",
    "【近期对话】",
    conversation && conversation.trim() ? conversation.trim() : "(无)",
    "",
    "【你的任务】",
    "1) 若主题未设定，请给出可辩论主题，并在 topic 字段填写。",
    "2) 严格遵循本轮角色与阶段规则发言，不越权、不抢答。",
    "3) reply 内容与时长匹配；提问者只提 1 个问题，回答者只回应问题。",
    evaluation ? "4) 根据评委评分，在 plan_update 中提供 0-5 条操作，必须包含针对性的改进措施。" : "4) 每轮辩论后都应更新 plan，在 plan_update 中提供 0-5 条操作，细化辩论规划和应对方案。",
    "5) plan_update 至少包含 1 条与对抗互动/技巧学习相关的可执行动作。",
    "6) 若为整场结束，experience_update 必须给出 1-3 条经验总结（强化学习模式：总结可复用的辩论技巧和策略）。",
    "",
    "【plan_update 操作格式】",
    "- 对象：{ \"op\": \"add\", \"text\": \"...\" }",
    "- 对象：{ \"op\": \"del\", \"text\": \"...\" }",
    "- 对象：{ \"op\": \"change\", \"from\": \"...\", \"to\": \"...\" }",
    "- 字符串：\"add: ...\" / \"del: ...\" / \"change: 旧 -> 新\"",
    "",
    "【输出格式（严格 JSON）】",
    "{",
    "  \"reply\": \"...\",",
    "  \"topic\": \"...\",",
    "  \"plan_update\": [ ... ],",
    "  \"experience_update\": [ ... ]",
    "}"
  ].join("\n");

  return { systemPrompt, userPrompt };
}

module.exports = { buildDebatePrompts };
