/* 用途：定义辩论流程（阶段、角色、规则、字数指导）并提供查询工具。
不负责：模型调用或状态持久化。
关联：src/agent.js, src/prompts.js。
*/

function makeGuide(min, max, hint, unit = "字") {
  return { min, max, hint, unit };
}

function calcMaxChars(minutes) {
  return Math.round(minutes * 300);
}

function normalizeFreeRounds(freeRounds) {
  return Math.max(1, Number.isFinite(freeRounds) ? freeRounds : 4);
}

function formatLengthGuide(guide) {
  if (!guide) return "-";
  const unit = guide.unit || "字";
  let range = "-";
  if (Number.isFinite(guide.min) && Number.isFinite(guide.max)) {
    range = `${guide.min}-${guide.max}${unit}`;
  } else if (Number.isFinite(guide.max)) {
    range = `≤${guide.max}${unit}`;
  } else if (Number.isFinite(guide.min)) {
    range = `≥${guide.min}${unit}`;
  }
  return guide.hint ? `${range}（${guide.hint}）` : range;
}

function formatStageLengthGuide(stage) {
  if (!stage || !stage.lengthGuide) return "-";
  const guideA = stage.lengthGuide.A || stage.lengthGuide;
  const guideB = stage.lengthGuide.B || stage.lengthGuide;
  if (guideA && guideB && JSON.stringify(guideA) === JSON.stringify(guideB)) {
    return formatLengthGuide(guideA);
  }
  const parts = [];
  if (guideA) parts.push(`A: ${formatLengthGuide(guideA)}`);
  if (guideB) parts.push(`B: ${formatLengthGuide(guideB)}`);
  return parts.length ? parts.join(" / ") : "-";
}

function getStageLengthGuide(stage, agentKey) {
  if (!stage || !stage.lengthGuide) return null;
  if (stage.lengthGuide.A || stage.lengthGuide.B) {
    return stage.lengthGuide[agentKey] || null;
  }
  return stage.lengthGuide || null;
}

function buildDebateFlow(freeRounds, options = {}) {
  const maxRounds = Number.isFinite(options.freeDebateMaxRounds) && options.freeDebateMaxRounds > 0
    ? options.freeDebateMaxRounds
    : freeRounds;
  const safeFreeRounds = normalizeFreeRounds(maxRounds);
  const freeDebateTotalChars = Number.isFinite(options.freeDebateTotalChars) ? options.freeDebateTotalChars : 0;
  const brainstormFlow = "头脑风暴流程：先发散列3个不同角度 → 选择1个最有冲突且可检验的角度 → 落地论点与边界 → 收束回扣对抗点。";
  const freeDebateRule = freeDebateTotalChars > 0
    ? `自由辩论由正方先发言，正反方轮流发言。总字数预算：每方${freeDebateTotalChars}字（预算优先，回合数仅为上限）。${brainstormFlow}`
    : `自由辩论由正方先发言，正反方轮流发言，共${safeFreeRounds}轮（回合数为上限，字数按阶段建议控制，约300字/轮）。${brainstormFlow}`;
  const flow = [
    {
      key: "opening",
      title: "陈词阶段-立论陈词",
      rule: "正方一辩陈词3分钟（约900字），反方一辩陈词3分钟（约900字）。",
      order: "A",
      roles: { A: "正方一辩", B: "反方一辩" },
      tasks: {
        A: "进行立论陈词，给出立场、定义、核心论点与证据，并说明边界条件。",
        B: "进行立论陈词，明确反方立场并指出正方核心漏洞与隐含前提。"
      },
      lengthGuide: {
        A: makeGuide(850, 950, "3分钟陈词"),
        B: makeGuide(850, 950, "3分钟陈词")
      },
      maxChars: { A: 900, B: 900 }
    },
    {
      key: "cross_1",
      title: "攻辩阶段-正方二辩提问",
      rule: "正方二辩提问，反方二辩或三辩回答；提问30秒（约150字），回答1分钟（约300字）。",
      order: "A",
      roles: { A: "正方二辩(提问)", B: "反方二辩/三辩(回答)" },
      tasks: {
        A: "提出1个尖锐问题，聚焦对方逻辑漏洞或证据缺口。",
        B: "直接回答问题，给出清晰理由或证据并点明边界。"
      },
      lengthGuide: {
        A: makeGuide(140, 160, "提问30秒"),
        B: makeGuide(280, 320, "回答1分钟")
      },
      maxChars: { A: 150, B: 300 }
    },
    {
      key: "cross_2",
      title: "攻辩阶段-反方二辩提问",
      rule: "反方二辩提问，正方二辩或三辩回答；提问30秒（约150字），回答1分钟（约300字）。",
      order: "B",
      roles: { A: "正方二辩/三辩(回答)", B: "反方二辩(提问)" },
      tasks: {
        A: "直接回答问题，给出清晰理由或证据并点明边界。",
        B: "提出1个尖锐问题，聚焦对方逻辑漏洞或证据缺口。"
      },
      lengthGuide: {
        A: makeGuide(280, 320, "回答1分钟"),
        B: makeGuide(140, 160, "提问30秒")
      },
      maxChars: { A: 300, B: 150 }
    },
    {
      key: "cross_3",
      title: "攻辩阶段-正方三辩提问",
      rule: "正方三辩提问，反方二辩或三辩回答；提问30秒（约150字），回答1分钟（约300字）。",
      order: "A",
      roles: { A: "正方三辩(提问)", B: "反方二辩/三辩(回答)" },
      tasks: {
        A: "提出1个尖锐问题，逼迫对方澄清或承认不足。",
        B: "直接回答问题，避免回避或跑题，并补充关键事实。"
      },
      lengthGuide: {
        A: makeGuide(140, 160, "提问30秒"),
        B: makeGuide(280, 320, "回答1分钟")
      },
      maxChars: { A: 150, B: 300 }
    },
    {
      key: "cross_4",
      title: "攻辩阶段-反方三辩提问",
      rule: "反方三辩提问，正方二辩或三辩回答；提问30秒（约150字），回答1分钟（约300字）。",
      order: "B",
      roles: { A: "正方二辩/三辩(回答)", B: "反方三辩(提问)" },
      tasks: {
        A: "直接回答问题，补强立场并避免新漏洞。",
        B: "提出1个尖锐问题，推动对方自证或限定范围。"
      },
      lengthGuide: {
        A: makeGuide(280, 320, "回答1分钟"),
        B: makeGuide(140, 160, "提问30秒")
      },
      maxChars: { A: 300, B: 150 }
    },
    {
      key: "cross_summary",
      title: "攻辩阶段-攻辩小结",
      rule: "四轮攻辩完毕后，正方一辩与反方一辩各作2分钟攻辩小结（约600字）。",
      order: "A",
      roles: { A: "正方一辩(攻辩小结)", B: "反方一辩(攻辩小结)" },
      tasks: {
        A: "针对攻辩态势总结己方优势与对方漏洞，不背稿，突出对抗点。",
        B: "针对攻辩态势总结己方优势与对方漏洞，不背稿，突出对抗点。"
      },
      lengthGuide: {
        A: makeGuide(550, 650, "2分钟小结"),
        B: makeGuide(550, 650, "2分钟小结")
      },
      maxChars: { A: 600, B: 600 }
    }
  ];

  for (let i = 0; i < safeFreeRounds; i += 1) {
    flow.push({
      key: `free_${i + 1}`,
      title: `自由辩论阶段-第${i + 1}轮`,
      rule: freeDebateRule,
      order: "A",
      roles: { A: "正方自由辩", B: "反方自由辩" },
      tasks: {
        A: "先回应对方最新观点，再推进己方核心论点，补充一个新角度或新证据。",
        B: "先回应对方最新观点，再推进己方核心论点，补充一个新角度或新证据。"
      },
      lengthGuide: {
        A: makeGuide(280, 320, "自由辩论单轮"),
        B: makeGuide(280, 320, "自由辩论单轮")
      },
      maxChars: { A: 300, B: 300 }
    });
  }

  flow.push({
    key: "closing",
    title: "总结陈词阶段",
    rule: "反方四辩总结陈词3分钟（约900字）；正方四辩总结陈词3分钟（约900字）。",
    order: "B",
    roles: { A: "正方四辩(总结陈词)", B: "反方四辩(总结陈词)" },
      tasks: {
      A: "最终总结，回扣核心论点与全场关键对抗点，明确胜负理由。",
      B: "最终总结，回扣核心论点与全场关键对抗点，明确胜负理由。"
    },
    lengthGuide: {
      A: makeGuide(850, 950, "3分钟总结"),
      B: makeGuide(850, 950, "3分钟总结")
    },
    maxChars: { A: 900, B: 900 }
  });

  return flow;
}

function getStageMaxChars(stage, agentKey) {
  if (!stage || !stage.maxChars) return null;
  if (typeof stage.maxChars === 'number') {
    return stage.maxChars;
  }
  if (stage.maxChars.A || stage.maxChars.B) {
    return stage.maxChars[agentKey] || null;
  }
  return null;
}

module.exports = {
  buildDebateFlow,
  getStageLengthGuide,
  getStageMaxChars,
  formatLengthGuide,
  formatStageLengthGuide
};
