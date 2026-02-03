/* 用途：定义辩论流程（阶段、角色、规则、字数指导）并提供查询工具。
不负责：模型调用或状态持久化。
关联：src/agent.js, src/prompts.js。
*/

function makeGuide(min, max, hint, unit = "字") {
  return { min, max, hint, unit };
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

function buildDebateFlow(freeRounds) {
  const safeFreeRounds = normalizeFreeRounds(freeRounds);
  const flow = [
    {
      key: "opening",
      title: "陈词阶段-立论陈词",
      rule: "正方一辩陈词3分钟，反方一辩陈词3分钟。",
      order: "A",
      roles: { A: "正方一辩", B: "反方一辩" },
      tasks: {
        A: "进行立论陈词，给出立场、定义、核心论点与证据。",
        B: "进行立论陈词，明确反方立场并指出正方核心漏洞。"
      },
      lengthGuide: {
        A: makeGuide(850, 950, "3分钟陈词"),
        B: makeGuide(850, 950, "3分钟陈词")
      }
    },
    {
      key: "cross_1",
      title: "攻辩阶段-正方二辩提问",
      rule: "正方二辩提问，反方二辩或三辩回答；提问30秒，回答1分钟。",
      order: "A",
      roles: { A: "正方二辩(提问)", B: "反方二辩/三辩(回答)" },
      tasks: {
        A: "提出1个尖锐问题，聚焦对方逻辑漏洞。",
        B: "直接回答问题，给出清晰理由或证据。"
      },
      lengthGuide: {
        A: makeGuide(140, 160, "提问30秒"),
        B: makeGuide(280, 320, "回答1分钟")
      }
    },
    {
      key: "cross_2",
      title: "攻辩阶段-反方二辩提问",
      rule: "反方二辩提问，正方二辩或三辩回答；提问30秒，回答1分钟。",
      order: "B",
      roles: { A: "正方二辩/三辩(回答)", B: "反方二辩(提问)" },
      tasks: {
        A: "直接回答问题，给出清晰理由或证据。",
        B: "提出1个尖锐问题，聚焦对方逻辑漏洞。"
      },
      lengthGuide: {
        A: makeGuide(280, 320, "回答1分钟"),
        B: makeGuide(140, 160, "提问30秒")
      }
    },
    {
      key: "cross_3",
      title: "攻辩阶段-正方三辩提问",
      rule: "正方三辩提问，反方二辩或三辩回答；提问30秒，回答1分钟。",
      order: "A",
      roles: { A: "正方三辩(提问)", B: "反方二辩/三辩(回答)" },
      tasks: {
        A: "提出1个尖锐问题，逼迫对方澄清或承认不足。",
        B: "直接回答问题，避免回避或跑题。"
      },
      lengthGuide: {
        A: makeGuide(140, 160, "提问30秒"),
        B: makeGuide(280, 320, "回答1分钟")
      }
    },
    {
      key: "cross_4",
      title: "攻辩阶段-反方三辩提问",
      rule: "反方三辩提问，正方二辩或三辩回答；提问30秒，回答1分钟。",
      order: "B",
      roles: { A: "正方二辩/三辩(回答)", B: "反方三辩(提问)" },
      tasks: {
        A: "直接回答问题，补强立场并避免新漏洞。",
        B: "提出1个尖锐问题，推动对方自证。"
      },
      lengthGuide: {
        A: makeGuide(280, 320, "回答1分钟"),
        B: makeGuide(140, 160, "提问30秒")
      }
    },
    {
      key: "cross_summary",
      title: "攻辩阶段-攻辩小结",
      rule: "四轮攻辩完毕后，正方一辩与反方一辩各作2分钟攻辩小结。",
      order: "A",
      roles: { A: "正方一辩(攻辩小结)", B: "反方一辩(攻辩小结)" },
      tasks: {
        A: "针对攻辩态势总结己方优势与对方漏洞，不背稿。",
        B: "针对攻辩态势总结己方优势与对方漏洞，不背稿。"
      },
      lengthGuide: {
        A: makeGuide(550, 650, "2分钟小结"),
        B: makeGuide(550, 650, "2分钟小结")
      }
    }
  ];

  for (let i = 0; i < safeFreeRounds; i += 1) {
    flow.push({
      key: `free_${i + 1}`,
      title: `自由辩论阶段-第${i + 1}轮`,
      rule: "自由辩论由正方先发言，正反方轮流发言，共8分钟，每方4分钟。",
      order: "A",
      roles: { A: "正方自由辩", B: "反方自由辩" },
      tasks: {
        A: "回应对方最新观点并推进己方核心论点。",
        B: "回应对方最新观点并推进己方核心论点。"
      },
      lengthGuide: {
        A: makeGuide(280, 320, "自由辩论单轮"),
        B: makeGuide(280, 320, "自由辩论单轮")
      }
    });
  }

  flow.push({
    key: "closing",
    title: "总结陈词阶段",
    rule: "反方四辩总结陈词3分钟；正方四辩总结陈词3分钟。",
    order: "B",
    roles: { A: "正方四辩(总结陈词)", B: "反方四辩(总结陈词)" },
    tasks: {
      A: "最终总结，回扣核心论点与全场关键对抗点。",
      B: "最终总结，回扣核心论点与全场关键对抗点。"
    },
    lengthGuide: {
      A: makeGuide(850, 950, "3分钟总结"),
      B: makeGuide(850, 950, "3分钟总结")
    }
  });

  return flow;
}

module.exports = {
  buildDebateFlow,
  getStageLengthGuide,
  formatLengthGuide,
  formatStageLengthGuide
};
