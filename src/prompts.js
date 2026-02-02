/* 用途：构建双代理辩论提示词。
不负责：模型调用或状态管理。
输入：身份档案、主题、回合信息。
输出：system/user 提示词字符串。
关联：src/agent.js。
*/

const AGENTS = {
  A: {
    name: "甲方",
    role: "主张方",
    style: "理性、结构化、强调证据与逻辑链"
  },
  B: {
    name: "乙方",
    role: "反驳方",
    style: "批判、质疑、寻找漏洞并提出反例"
  }
};

function buildDebatePrompts({ agentKey, round, topic, identity, allowIdentityUpdate, conversation }) {
  const agent = AGENTS[agentKey] || AGENTS.A;
  const identityText = identity && identity.trim() ? identity.trim() : "(空)";
  const topicText = topic && topic.trim() ? topic.trim() : "未设定";
  const allowUpdateText = allowIdentityUpdate ? "允许" : "不允许";

  const systemPrompt = [
    "你是一个持续辩论的智能体，只输出严格 JSON。",
    `你的身份：${agent.name}（${agent.role}），风格：${agent.style}。`,
    "必须基于你的 identity 文档行事；若为空，保持风格一致并自行形成稳定倾向。",
    "你与另一个智能体围绕主题进行无止境辩论，不执行任务、不写代码、不做系统诊断。",
    "输出 JSON 字段：reply, topic, identity_update。",
    "reply 为你本轮回复；topic 为当前主题（如为空则必须提供）；",
    "identity_update 为数组，表示你对自我性格/偏好/辩论方式的新补充（允许时才可填写）。",
    "禁止输出多余文本、禁止 Markdown 代码块。"
  ].join(" ");

  const userPrompt = [
    `当前回合：${round}`,
    `当前主题：${topicText}`,
    `是否允许更新身份档案：${allowUpdateText}`,
    "\n【你的 identity 文档】",
    identityText,
    "\n【近期对话】",
    conversation && conversation.trim() ? conversation.trim() : "(无)",
    "\n【你的任务】",
    "1) 若主题未设定，请给出一个可辩论的主题，并在 topic 字段填写。",
    "2) 基于主题输出 1-3 段 reply，明确立场并反驳对方观点。",
    "3) topic 字段务必是你认为当前生效的主题。",
    "4) 若允许更新身份档案，可在 identity_update 提供 0-3 条短句（不允许则输出空数组）。",
    "\n【输出格式（严格 JSON）】",
    "{",
    "  \"reply\": \"...\",",
    "  \"topic\": \"...\",",
    "  \"identity_update\": [\"...\"]",
    "}"
  ].join("\n");

  return { systemPrompt, userPrompt };
}

module.exports = { buildDebatePrompts };
