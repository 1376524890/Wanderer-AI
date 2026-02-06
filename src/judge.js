/* 用途：实现专业评委系统，对辩论进行多维度评分。
不负责：渲染界面或存储状态。
输入：辩论上下文、双方发言。
输出：评分结果、反馈建议。
关联：src/agent.js, src/journal.js。
*/

class DebateJudge {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.llm = require("./llmClient").LlmClient;
    this.llmClient = new this.llm(config, logger);
  }

  async evaluateRound(debateContext) {
    const { topic, stage, replyA, replyB, speakerA, speakerB, round, stageKey, stageRule } = debateContext;
    
    const systemPrompt = `你是一位专业辩论评委，具有丰富的辩论赛事经验。你需要客观、公正、中立地评估双方的表现。

评估维度（每项1-10分，10分为满分）：
1. 论点逻辑性（logic）：论点是否清晰、逻辑严密、论证链条完整
2. 证据充分性（evidence）：是否有充分的事实、数据、理论支撑
3. 反应敏锐度（responsiveness）：是否有效回应对方观点，是否抓住对方漏洞
4. 语言表达（expression）：表达是否清晰流畅、有感染力、符合规范
5. 规则遵守（rule_compliance）：是否符合阶段规则（如提问只提问，回答只回答）

评分标准：
- 9-10分：优秀，表现突出，无明显瑕疵
- 7-8分：良好，整体表现不错，有小瑕疵
- 5-6分：一般，表现中规中矩，有明显不足
- 3-4分：较差，存在较多问题
- 1-2分：极差，严重违反规则或完全不合格

你还需要：
1. 判定本轮胜方（A/B/tie）
2. 指出双方的关键亮点（每方最多3条）
3. 给出改进建议（每方最多3条）

输出严格JSON格式，不要包含任何其他文本。`;

    const userPrompt = `【辩论信息】
主题：${topic || "未设定"}
轮次：${round}
阶段：${stage} (${stageKey})
阶段规则：${stageRule || "无特殊规则"}

【正方${speakerA}发言】
${replyA || "(无发言)"}

【反方${speakerB}发言】
${replyB || "(无发言)"}

请评估双方表现并输出JSON格式：

{
  "scores": {
    "A": {
      "logic": 0,
      "evidence": 0,
      "responsiveness": 0,
      "expression": 0,
      "rule_compliance": 0
    },
    "B": {
      "logic": 0,
      "evidence": 0,
      "responsiveness": 0,
      "expression": 0,
      "rule_compliance": 0
    }
  },
  "averages": {
    "A": 0,
    "B": 0
  },
  "round_winner": "A/B/tie",
  "highlights": {
    "A": ["亮点1"],
    "B": ["亮点1"]
  },
  "suggestions": {
    "A": ["建议1"],
    "B": ["建议1"]
  }
}`;

    try {
      const result = await this.llmClient.chat(systemPrompt, userPrompt, { 
        model: this.config.vllmModel,
        temperature: 0.3,
        maxTokens: 2048
      });
      
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("无法解析评委JSON响应");
      }
      
      const evaluation = JSON.parse(jsonMatch[0]);
      
      this.logger?.info("judge.round.evaluation", {
        round,
        winner: evaluation.round_winner,
        avgA: evaluation.averages.A,
        avgB: evaluation.averages.B
      });
      
      return evaluation;
    } catch (err) {
      this.logger?.error("judge.round.failed", { 
        round, 
        error: err?.message || String(err) 
      });
      return this.getDefaultEvaluation();
    }
  }

  getDefaultEvaluation() {
    return {
      scores: {
        A: { logic: 5, evidence: 5, responsiveness: 5, expression: 5, rule_compliance: 5 },
        B: { logic: 5, evidence: 5, responsiveness: 5, expression: 5, rule_compliance: 5 }
      },
      averages: { A: 5, B: 5 },
      round_winner: "tie",
      highlights: { A: [], B: [] },
      suggestions: { 
        A: ["评委评估失败，请继续发挥"], 
        B: ["评委评估失败，请继续发挥"] 
      }
    };
  }

  async evaluateDebate(debateHistory, topic) {
    const systemPrompt = `你是一位资深辩论总评委，具有多年国际辩论赛事裁判经验。你需要对整场辩论进行综合评估，判定胜负并给出详细分析。

你的任务：
1. 判定整场辩论的胜负（正方A / 反方B / 平局）
2. 识别关键转折点（辩论局势发生重大变化的时刻）
3. 分析决定性因素（导致胜负的关键因素，最多3个）
4. 总结双方优点（每方最多5条）
5. 指出双方不足（每方最多5条）
6. 给出最终综合评分（每方总分100分）

评分标准：
- 90-100分：表现卓越，具有压倒性优势
- 80-89分：表现优秀，有明显优势
- 70-79分：表现良好，略有优势
- 60-69分：表现一般，势均力敌
- 50-59分：表现较差，处于劣势
- 0-49分：表现极差，全面落后

输出严格JSON格式。`;

    const userPrompt = `【辩论主题】
${topic || "未设定"}

【辩论历史】
${debateHistory}

请进行综合评估并输出JSON格式：

{
  "winner": "A/B/tie",
  "key_turning_points": [
    {
      "round": 1,
      "description": "转折点描述"
    }
  ],
  "decisive_factors": ["因素1", "因素2", "因素3"],
  "strengths": {
    "A": ["优点1", "优点2"],
    "B": ["优点1", "优点2"]
  },
  "weaknesses": {
    "A": ["不足1", "不足2"],
    "B": ["不足1", "不足2"]
  },
  "final_scores": {
    "A": 0,
    "B": 0
  },
  "overall_comment": "对整场辩论的整体评价（2-3句话）"
}`;

    try {
      const result = await this.llmClient.chat(systemPrompt, userPrompt, {
        model: this.config.vllmModel,
        temperature: 0.3,
        maxTokens: 3072
      });
      
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("无法解析总评委JSON响应");
      }
      
      const finalEvaluation = JSON.parse(jsonMatch[0]);
      
      this.logger?.info("judge.debate.evaluation", {
        winner: finalEvaluation.winner,
        scoreA: finalEvaluation.final_scores.A,
        scoreB: finalEvaluation.final_scores.B
      });
      
      return finalEvaluation;
    } catch (err) {
      this.logger?.error("judge.debate.failed", { 
        error: err?.message || String(err) 
      });
      return this.getDefaultDebateEvaluation();
    }
  }

  getDefaultDebateEvaluation() {
    return {
      winner: "tie",
      key_turning_points: [],
      decisive_factors: ["评委评估失败"],
      strengths: { A: [], B: [] },
      weaknesses: { A: [], B: [] },
      final_scores: { A: 50, B: 50 },
      overall_comment: "评委评估失败，无法给出综合评价。"
    };
  }
}

module.exports = { DebateJudge };
