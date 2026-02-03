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
    style: "理性、结构化、强调证据、逻辑与论证链"
  },
  B: {
    name: "反方",
    role: "反方团队",
    style: "批判、质疑、寻找漏洞并提出反例与替代解释"
  }
};

function buildDebatePrompts({
  agentKey,
  round,
  debateId,
  debateRound,
  debateTotalRounds,
  stageTitle,
  stageRule,
  role,
  task,
  speakerOrder,
  topic,
  identity,
  experience,
  allowIdentityUpdate,
  isDebateStart,
  isDebateEnd,
  conversation
}) {
  const agent = AGENTS[agentKey] || AGENTS.A;
  const identityText = identity && identity.trim() ? identity.trim() : "(空)";
  const experienceText = experience && experience.trim() ? experience.trim() : "(空)";
  const topicText = topic && topic.trim() ? topic.trim() : "未设定";
  const allowUpdateText = allowIdentityUpdate ? "允许" : "不允许";
  const orderText = speakerOrder === "first" ? "先手" : "后手";
  const debateStartText = isDebateStart ? "是" : "否";
  const debateEndText = isDebateEnd ? "是" : "否";

  const systemPrompt = [
    "你是模拟人类辩论赛的智能体，只输出严格 JSON。",
    `你的阵营：${agent.name}（${agent.role}），风格：${agent.style}。`,
    "必须基于你的 identity 文档行事；experience 文档是双方共享的经验准则。",
    "只可修改自己的 identity 文档，不得改动对方身份。",
    "输出字段：reply, topic, identity_update, experience_update。",
    "reply 为本轮发言；topic 为当前主题（如为空则必须给出）。",
    "identity_update 为数组，支持 add/del/change 操作；仅在允许更新时填写，否则必须为空数组。",
    "experience_update 仅在整场辩论结束时填写 1-3 条可执行经验总结，否则必须为空数组。",
    "可见性约束：identity/experience 仅供内部参考，不得在 reply 中直接复述或泄露。",
    "禁止输出多余文本、禁止 Markdown 代码块。"
  ].join(" ");

  const userPrompt = [
    `当前全局回合：${round}`,
    `当前辩论场次：${debateId ?? "-"}`,
    `辩论轮次：${debateRound ?? "-"} / ${debateTotalRounds ?? "-"}`,
    `阶段：${stageTitle || "-"}`,
    `阶段规则：${stageRule || "-"}`,
    `你的角色：${role || "-"}`,
    `发言顺序：${orderText}`,
    `本轮任务：${task || "-"}`,
    `是否为新辩题开场：${debateStartText}`,
    `是否为整场结束：${debateEndText}`,
    `当前主题：${topicText}`,
    `是否允许更新身份档案：${allowUpdateText}`,
    "",
    "【辩论时长模拟】",
    "3分钟≈2-3段；2分钟≈1-2段；1分钟≈1段；30秒≈1-2句。",
    "",
    "【共享 experience 文档】",
    experienceText,
    "",
    "【你的 identity 文档】",
    identityText,
    "",
    "【近期对话】",
    conversation && conversation.trim() ? conversation.trim() : "(无)",
    "",
    "【你的任务】",
    "1) 若主题未设定，请给出可辩论主题，并在 topic 字段填写。",
    "2) 严格遵循本轮角色与阶段规则发言，不越权、不抢答。",
    "3) reply 内容与时长匹配；提问者只提 1 个问题，回答者只回应问题。",
    "4) 若为新辩题开场，必须先生成计划并写入 identity_update（add 操作）。",
    "5) 若允许更新身份档案，可在 identity_update 提供 0-5 条操作；否则输出空数组。",
    "6) 若为整场结束，experience_update 必须给出 1-3 条经验总结。",
    "",
    "【identity_update 操作格式】",
    "- 对象：{ \"op\": \"add\", \"text\": \"...\" }",
    "- 对象：{ \"op\": \"del\", \"text\": \"...\" }",
    "- 对象：{ \"op\": \"change\", \"from\": \"...\", \"to\": \"...\" }",
    "- 字符串：\"add: ...\" / \"del: ...\" / \"change: 旧 -> 新\"",
    "",
    "【输出格式（严格 JSON）】",
    "{",
    "  \"reply\": \"...\",",
    "  \"topic\": \"...\",",
    "  \"identity_update\": [ ... ],",
    "  \"experience_update\": [ ... ]",
    "}"
  ].join("\n");

  return { systemPrompt, userPrompt };
}

module.exports = { buildDebatePrompts };
