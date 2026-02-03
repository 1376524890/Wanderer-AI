# 双代理永续辩论系统

## 概述
本项目将原有单代理创作改为“双代理持续辩论”。系统维护两份自我身份档案（identity），每轮回答都基于档案内容；每 3 轮对话结束后，代理可以选择更新自身 identity。系统同时记录对话、身份更新与运行状态，并提供实时 CLI 监控界面。

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
  - 实时推送辩论内容与系统状态
  - 自动翻页/自动滚动、搜索过滤、连接状态提示

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

## Web 控制台
默认地址：`http://localhost:3000`  
可通过 `.env` 设置：
- `WEB_PORT`：端口（默认 3000）
- `WEB_HOST`：监听地址（默认 0.0.0.0）

## 主要目录
- `src/agent.js`：辩论主循环
- `src/prompts.js`：提示词构建
- `src/monitor.js`：CLI 监控界面
- `src/webServer.js`：Web 监控接口（HTTP + SSE）
- `web/`：Vue 前端页面
- `state/`：运行状态、identity 文档、对话流
- `journal/`：每日可读日志
- `logs/`：JSONL 结构化事件日志
