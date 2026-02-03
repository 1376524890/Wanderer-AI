#!/usr/bin/env bash
# 用途：一键创建环境、安装依赖并后台启动辩论引擎 + Web UI。
# 不负责：替代 systemd 或进程守护。
# 输入：当前目录与可选 .env 配置。
# 输出：依赖安装日志与后台进程 PID。
# 关联：package.json, run-agent.js, run-web.js。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "未检测到 .env，已从 .env.example 复制。"
  cp .env.example .env
fi

if command -v python3 >/dev/null 2>&1; then
  if [ ! -d .venv ]; then
    echo "创建可选 Python 虚拟环境 .venv（如不需要可忽略）。"
    python3 -m venv .venv
  fi
else
  echo "未检测到 python3，跳过虚拟环境创建。"
fi

echo "安装 Node.js 依赖..."
npm install

STATE_DIR=$(grep -m1 "^STATE_DIR=" .env 2>/dev/null | cut -d= -f2- || true)
LOG_DIR=$(grep -m1 "^LOG_DIR=" .env 2>/dev/null | cut -d= -f2- || true)
STATE_DIR="${STATE_DIR:-state}"
LOG_DIR="${LOG_DIR:-logs}"

mkdir -p "$STATE_DIR" "$LOG_DIR"

echo "后台启动辩论引擎与 Web UI..."
nohup node run-agent.js >"$LOG_DIR/agent.out" 2>&1 &
AGENT_PID=$!
nohup node run-web.js >"$LOG_DIR/web.out" 2>&1 &
WEB_PID=$!

echo "$AGENT_PID" >"$STATE_DIR/agent.pid"
echo "$WEB_PID" >"$STATE_DIR/web.pid"

echo "✅ 已后台启动"
echo "   - Agent PID: $AGENT_PID (log: $LOG_DIR/agent.out)"
echo "   - Web   PID: $WEB_PID (log: $LOG_DIR/web.out)"
