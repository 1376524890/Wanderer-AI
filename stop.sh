#!/usr/bin/env bash
# 用途：停止后台启动的辩论引擎与 Web UI。
# 不负责：停止 systemd 或其他守护进程。
# 输入：.env 中的 STATE_DIR（可选）。
# 输出：停止结果与 PID 清理。
# 关联：start.sh。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

STATE_DIR=$(grep -m1 "^STATE_DIR=" .env 2>/dev/null | cut -d= -f2- || true)
STATE_DIR="${STATE_DIR:-state}"

stop_by_pidfile() {
  local name="$1"
  local pidfile="$2"
  if [ ! -f "$pidfile" ]; then
    echo "⚠️  未找到 $name PID 文件: $pidfile"
    return
  fi
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    echo "⚠️  $name PID 文件为空，已忽略"
    rm -f "$pidfile"
    return
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "停止 $name (PID $pid)..."
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "⚠️  $name 未退出，尝试强制终止 (PID $pid)"
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  else
    echo "ℹ️  $name 进程不存在 (PID $pid)"
  fi
  rm -f "$pidfile"
}

stop_by_pidfile "Agent" "$STATE_DIR/agent.pid"
stop_by_pidfile "Web" "$STATE_DIR/web.pid"

echo "✅ 停止完成"
