/* 用途：加载与校验辩论技能 profiles。
不负责：状态机或奖励计算。
输入：skills.json 路径。
输出：标准化的技能对象。
关联：src/agent.js, src/debateDynamics.js。
*/

const fs = require("fs");

const DEFAULT_SKILLS = {
  pressure_awareness: 0.6,
  commitment: 0.6,
  aggression: 0.6,
  recovery: 0.6,
  evidence_control: 0.5
};

function clampSkill(value) {
  if (!Number.isFinite(value)) return 0.6;
  return Math.min(0.95, Math.max(0.05, value));
}

function normalizeSkillSet(raw) {
  const base = { ...DEFAULT_SKILLS, ...(raw || {}) };
  return {
    pressure_awareness: clampSkill(Number(base.pressure_awareness)),
    commitment: clampSkill(Number(base.commitment)),
    aggression: clampSkill(Number(base.aggression)),
    recovery: clampSkill(Number(base.recovery)),
    evidence_control: clampSkill(Number(base.evidence_control))
  };
}

function loadSkills(skillsPath) {
  let raw = null;
  try {
    if (skillsPath && fs.existsSync(skillsPath)) {
      raw = JSON.parse(fs.readFileSync(skillsPath, "utf8"));
    }
  } catch (err) {
    raw = null;
  }

  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    A: normalizeSkillSet(safe.A),
    B: normalizeSkillSet(safe.B)
  };
}

module.exports = {
  loadSkills,
  normalizeSkillSet,
  DEFAULT_SKILLS
};
