#!/usr/bin/env node

const { loadConfig } = require('./src/config');
const { DebateJudge } = require('./src/judge');
const { createLogger } = require('./src/logger');

async function testJudgeRetry() {
  console.log('🧪 测试评委重试机制...\n');

  const config = loadConfig();
  const logger = createLogger(config);
  const judge = new DebateJudge(config, logger);

  console.log('✅ 评委系统初始化成功\n');

  console.log('📝 测试：短文本评估（应快速响应）...');
  try {
    const evaluation = await judge.evaluateRound({
      topic: '测试辩题',
      stage: '测试阶段',
      stageKey: 'test',
      stageRule: '测试规则',
      replyA: '正方简短发言，测试系统功能。',
      replyB: '反方简短发言，验证评估正常。',
      speakerA: '正方',
      speakerB: '反方',
      round: 1
    });

    console.log('   ✅ 评分成功！');
    console.log(`   📊 胜方: ${evaluation.round_winner}`);
    console.log(`   📊 正方平均分: ${evaluation.averages.A.toFixed(2)}`);
    console.log(`   📊 反方平均分: ${evaluation.averages.B.toFixed(2)}`);
  } catch (err) {
    console.error(`   ❌ 评分失败: ${err.message}`);
    process.exit(1);
  }

  console.log('\n✨ 测试通过！\n');
}

testJudgeRetry().catch(err => {
  console.error('\n❌ 测试失败：', err);
  process.exit(1);
});
