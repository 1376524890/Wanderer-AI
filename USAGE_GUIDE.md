# 辩论系统使用指南

## 快速开始

### 1. 环境配置

确保 `.env` 文件中包含以下配置：

```bash
# LLM API配置
VLLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
VLLM_MODEL=glm-4.7-flash
VLLM_API_KEY=your_api_key_here

# 时间控制（新增）
TIME_CONTROL_ENABLED=true
REQUEST_TIMEOUT_SECONDS=120

# Experience文档大小（调整）
EXPERIENCE_MAX_CHARS=5000
```

### 2. 启动系统

```bash
# 启动辩论Agent
npm run agent

# 或者直接运行
node run-agent.js
```

### 3. 查看实时状态

```bash
# 使用监控工具
npm run monitor

# 或者直接查看状态文件
cat state/status.json | jq
```

---

## 核心功能说明

### ⚖️ 评委评分系统

#### 评分维度（每轮1-10分）

1. **论点逻辑性（logic）**
   - 论点清晰度
   - 逻辑严密性
   - 论证链条完整性

2. **证据充分性（evidence）**
   - 事实、数据、理论支撑
   - 证据的可靠性
   - 证据与论点的关联性

3. **反应敏锐度（responsiveness）**
   - 回应对方观点的有效性
   - 抓住对方漏洞的能力
   - 避免回避问题

4. **语言表达（expression）**
   - 表达清晰度、流畅度
   - 语言的感染力
   - 表达的规范性

5. **规则遵守（rule_compliance）**
   - 是否符合阶段规则
   - 提问者是否只提问
   - 回答者是否只回答

#### 评分标准

- **9-10分**：优秀，表现突出，无明显瑕疵
- **7-8分**：良好，整体表现不错，有小瑕疵
- **5-6分**：一般，表现中规中矩，有明显不足
- **3-4分**：较差，存在较多问题
- **1-2分**：极差，严重违反规则或完全不合格

#### 评分时机

- **每轮辩论结束后**：立即评分
- **整场辩论结束后**：综合评判

### ⏱️ 时间控制系统

#### 各阶段时间限制

| 阶段 | 角色 | 时限 | 说明 |
|------|------|------|------|
| 开篇立论 | 双方 | 180秒 | 每方3分钟 |
| 攻辩提问 | 提问方 | 30秒 | 快速提问 |
| 攻辩回答 | 回答方 | 60秒 | 详细回应 |
| 攻辩小结 | 双方 | 120秒 | 每方2分钟 |
| 自由辩论 | 双方 | 60秒 | 每轮每方1分钟 |
| 总结陈词 | 双方 | 180秒 | 每方3分钟 |

#### 时间控制行为

- ✅ **启用时**：超时自动中断
- ❌ **禁用时**：无时间限制
- ⚠️ **配置**：通过 `TIME_CONTROL_ENABLED` 环境变量控制

### 📊 Agent评分可见

#### Agent可以看到的信息

```javascript
// 每轮辩论前，Agent会看到：
{
  "my_scores": {
    "average": 7.2,
    "details": {
      "logic": 8,
      "evidence": 7,
      "responsiveness": 6,
      "expression": 7,
      "rule_compliance": 8
    }
  },
  "opponent_scores": {
    "average": 7.0,
    "details": { ... }
  },
  "suggestions": [
    "需要更多数据支撑",
    "逻辑链条可以更严密"
  ],
  "opponent_highlights": [
    "反应敏捷",
    "抓住了逻辑漏洞"
  ]
}
```

#### 如何使用评分更新策略

Agent会在 `plan_update` 中根据评分调整：

```javascript
{
  "plan_update": [
    "add: 根据评委建议，加强数据支撑",
    "add: 强化逻辑链条的严密性",
    "change: 提升反应敏锐度，针对对方漏洞快速回应",
    "del: 缺乏数据支撑的论点"
  ]
}
```

### 🧠 强化学习机制

#### Experience文档结构

```markdown
## [2026-02-05 16:00:00 UTC+8] Debate 1 | Topic: 辩论主题
- A: 策略调整1
- B: 策略调整2

### 强化学习统计
- 评估轮数: 11
- 正方平均分: 7.35/10
- 反方平均分: 7.18/10
- 累计总分: 正方 80.85 | 反方 79.02
- 表现评估: 正方领先
```

#### 强化学习循环

```
辩论表现
    ↓
评委评分
    ↓
Agent查看评分
    ↓
调整策略（plan_update）
    ↓
改进表现
    ↓
Experience积累
    ↓
下一轮辩论
```

---

## 查看结果

### 1. 实时状态

```bash
# 查看完整状态
cat state/status.json | jq

# 查看评分进度
cat state/status.json | jq '{round, cumulativeScores, avgScores}'

# 查看当前轮次评分
cat state/status.json | jq '.evaluation'
```

### 2. 辩论日志

```bash
# 查看当前对话
tail -f state/conversation.log

# 查看特定轮次
grep "Round 3" state/conversation.log
```

### 3. Experience文档

```bash
# 查看强化学习积累
cat state/experience.md

# 查看最近的经验
tail -50 state/experience.md
```

### 4. 评委评分记录

```bash
# 查看系统日志（包含评分）
tail -f logs/wanderer.log

# 查看JSON格式事件（解析评分）
tail -f logs/debate_events.jsonl | jq '.payload | select(.type=="round_evaluation")'
```

### 5. 每日Journal

```bash
# 查看今天的journal
cat journal/$(date +%Y-%m-%d).md

# 查看历史journal
ls journal/
```

---

## 常见问题

### Q1: 如何禁用时间控制？

**A**: 在 `.env` 文件中设置：
```bash
TIME_CONTROL_ENABLED=false
```

### Q2: 如何调整评分严格度？

**A**: 目前使用默认评分标准。如需调整，可修改 `src/judge.js` 中的 `systemPrompt`。

### Q3: 如何查看整场辩论的最终结果？

**A**: 查看 journal 文件的最终评判部分：
```bash
grep -A 30 "🏆 辩论赛最终结果" journal/$(date +%Y-%m-%d).md
```

### Q4: Experience文档太大怎么办？

**A**: 调整环境变量：
```bash
EXPERIENCE_MAX_CHARS=3000  # 降低到3000字符
```

### Q5: 如何重置Agent的经验？

**A**: 删除 `state/experience.md` 文件：
```bash
rm state/experience.md
```

系统会自动创建新的文档。

---

## 性能指标

### 单场辩论（11轮）

- **耗时**：20-25分钟
- **API调用次数**：约33次
- **评分次数**：11轮 + 1次最终评判

### 资源占用

- **内存**：约200-300MB
- **CPU**：单核心即可
- **网络**：取决于LLM API响应速度

---

## 最佳实践

### 1. 配置优化

```bash
# 生产环境推荐配置
TIME_CONTROL_ENABLED=true
REQUEST_TIMEOUT_SECONDS=120
EXPERIENCE_MAX_CHARS=5000
FREE_DEBATE_ROUNDS=4
```

### 2. 日志管理

```bash
# 定期清理旧日志
find logs/ -name "*.log" -mtime +7 -delete
find journal/ -name "*.md" -mtime +30 -delete
```

### 3. 监控建议

- 定期查看 `state/status.json` 监控进度
- 关注 `logs/wanderer.log` 中的错误信息
- 定期检查 Experience 文档大小

---

## 下一步

- 查看 [IMPROVEMENT_PLAN.md](./IMPROVEMENT_PLAN.md) 了解改进详情
- 查看 `state/status.json` 查看实时状态
- 查看 `journal/$(date +%Y-%m-%d).md` 查看完整辩论记录

---

## 技术支持

如遇到问题，请检查：

1. ✅ API密钥是否正确
2. ✅ 网络连接是否正常
3. ✅ 环境变量是否设置正确
4. ✅ 日志文件中的错误信息

---

**文档版本**：v1.0  
**最后更新**：2026-02-05
