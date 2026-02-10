# 双代理永续辩论系统

> **✨ v3.0 新增**：状态机对抗、技能档案（skills）、意图/动作监控、奖励混合与 Curriculum 训练

## 概述
本项目将原有单代理创作改为"双代理持续辩论"。系统维护两份自我身份档案（identity），每轮回答都基于档案内容；每 3 轮对话结束后，代理可以选择更新自身 identity。系统同时记录对话、身份更新与运行状态，并提供实时 CLI 监控界面与 Web 控制台。

**v2.0 新增功能**：
- ⚖️ **专业评委系统** - 多维度评分（逻辑性、证据性、反应度、表达力、规则遵守）
- ⏱️ **时间控制系统** - 真实倒计时（开篇3分钟、提问30秒、回答1分钟等）
- 📊 **评分可见机制** - Agent可查看自己与对方的得分，根据评委建议调整策略
- 🧠 **强化学习机制** - Experience文档 + 策略梯度权重，能力持续提升

**v3.0 新增功能**：
- ⚔️ **对抗状态机** - Neutral / Pressure / Defense / Advantage / Collapse
- 🧬 **技能档案（skills）** - 影响状态识别与奖励权重（skills.json）
- 🎯 **意图/动作监控** - Policy 选择 intent，Analyzer 反向识别并惩罚不一致
- 🎓 **Curriculum 训练** - 分阶段启用惩罚/崩溃奖励，训练更稳定
- ⚖️ **奖励混合** - Debate Reward 80% + Judge Score 20%

## 功能特性
- 双代理围绕自定主题持续辩论（主题可由代理提出）
- 两份 identity 文档持续更新、可追溯
- 日志系统记录对话内容与身份变更
- CLI 界面：
  - 顶部状态栏：UTC+8 时间、当前主题
  - 左侧：对话内容
  - 右侧：两份 identity 内容（上下分栏）
  - 底部状态栏：轮次、上次回复时间、API 状态、延迟、token 使用
- API 连接失败自动重试与状态跟踪
 - Web 控制台（Vue）：
   - 对抗状态/动作/奖励/intent/skills 实时监控
   - 评委评分与训练焦点可视化

## 快速开始
1. 配置 `.env`（可参考 `.env.example`）
2. 启动辩论引擎：
   ```bash
   node run-agent.js
   ```
3. 启动监控面板：
   ```bash
   node run-monitor.js
   ```
4. 启动 Web 控制台：
   ```bash
   node run-web.js
   ```
5. 或使用一键启动：
   ```bash
   ./start.sh
   ```

## 启动方式速览
- 单独启动辩论引擎：`node run-agent.js`
- 单独启动监控面板：`node run-monitor.js`
- 启动 Web 控制台：`node run-web.js` 或 `npm run web`
- 同时启动：`npm run start:all` 或 `./start.sh`
- 停止后台进程：`./stop.sh`

## 运行记录清理
- 预览清理：`scripts/clean-runtime.sh --dry-run`
- 彻底重置（含 skills 与 RL）：`scripts/clean-runtime.sh --restart`

## Web 控制台
默认地址：`http://localhost:3000`  
可通过 `.env` 设置：
- `WEB_PORT`：端口（默认 3000）
- `WEB_HOST`：监听地址（默认 0.0.0.0）
### 新增监控字段
- `skills.json`：技能档案
- `curriculum_phase`：训练阶段
- `reward_mix`：奖励混合比例
- `debate_states / detected_actions / reward_signals`：状态机信号

## 主要目录
- `src/agent.js`：辩论主循环
- `src/prompts.js`：提示词构建
- `src/monitor.js`：CLI 监控界面
- `src/webServer.js`：Web 监控接口（HTTP + SSE）
- `web/`：Vue 前端页面
- `state/`：运行状态、identity 文档、对话流
- `state/skills.json`：技能档案（可手动调整）
- `journal/`：每日可读日志
- `logs/`：JSONL 结构化事件日志

## 📚 文档

- **[USAGE_GUIDE.md](./USAGE_GUIDE.md)** - 完整使用指南（含v2.0新功能）
- **[IMPROVEMENT_PLAN.md](./IMPROVEMENT_PLAN.md)** - 系统改进方案
- **[IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)** - 实施总结

## 🧪 测试

运行评委系统测试：
```bash
node test-judge.js
```

## 🆕 v2.0 新功能

### 评委评分系统
每轮辩论结束后，专业评委Agent会从5个维度进行评分：
- 论点逻辑性（logic）
- 证据充分性（evidence）
- 反应敏锐度（responsiveness）
- 语言表达（expression）
- 规则遵守（rule_compliance）

### 时间控制
真实倒计时机制，模拟真实辩论时间压力：
- 开篇立论：180秒/方
- 攻辩提问：30秒
- 攻辩回答：60秒
- 自由辩论：60秒/轮
- 总结陈词：180秒/方

### 强化学习
Agent根据评委评分进行策略梯度更新（战术权重 + 训练焦点），并在Experience文档中积累经验，实现持续提升。

详见 [USAGE_GUIDE.md](./USAGE_GUIDE.md) 了解详情。

## 🆕 v3.0 使用要点（新增）

### skills.json
`state/skills.json` 存储 A/B 技能档案。默认由 `./start.sh` 自动初始化，可按需手动调整。

### Curriculum 与奖励混合
建议在 `.env` 中配置：
```
CURRICULUM_PHASE=1
STATE_REWARD_WEIGHT=0.8
ACTION_MISMATCH_PENALTY=0.6
```

### 运行记录清理
`scripts/clean-runtime.sh --restart` 现在会一并清理 `skills.json`，用于彻底重置训练状态。
