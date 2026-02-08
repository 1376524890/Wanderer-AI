#!/usr/bin/env bash
# 清理运行记录与生成文件，仅保留 git 跟踪的原始代码文件。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
用法: scripts/clean-runtime.sh [--dry-run] [--all] [--restart|--reset]

  --dry-run  仅显示将要删除的内容，不执行删除
  --all      额外删除依赖/虚拟环境（node_modules/、.venv/）
  --restart  彻底清除历史记录并重置身份/经验/强化学习策略（适合一键重新开始）
  --reset    --restart 的别名
USAGE
}

DRY_RUN=0
REMOVE_ALL=0
RESTART_ALL=0

load_env_file() {
  local env_file="$ROOT_DIR/.env"
  if [ ! -f "$env_file" ]; then
    return
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    if [ -z "$line" ]; then
      continue
    fi
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      local key="${line%%=*}"
      local value="${line#*=}"
      value="${value%\"}"
      value="${value#\"}"
      value="${value%\'}"
      value="${value#\'}"
      export "$key=$value"
    fi
  done < "$env_file"
}

resolve_path() {
  local target="$1"
  if [ -z "$target" ]; then
    echo ""
    return
  fi
  if [[ "$target" = /* ]]; then
    echo "$target"
  else
    echo "$ROOT_DIR/$target"
  fi
}

load_env_file

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --all)
      REMOVE_ALL=1
      ;;
    --restart|--reset)
      RESTART_ALL=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ ! -d "$ROOT_DIR/.git" ] && [ ! -f "$ROOT_DIR/package.json" ]; then
  echo "错误：未检测到项目根目录（缺少 .git 或 package.json）。" >&2
  exit 1
fi

STATE_DIR="${STATE_DIR:-state}"
JOURNAL_DIR="${JOURNAL_DIR:-journal}"
LOG_DIR="${LOG_DIR:-logs}"
IDENTITY_DIR="${IDENTITY_DIR:-$STATE_DIR}"
IDENTITY_A_FILE="${IDENTITY_A_FILE:-identity_a.md}"
IDENTITY_B_FILE="${IDENTITY_B_FILE:-identity_b.md}"
EXPERIENCE_DIR="${EXPERIENCE_DIR:-$STATE_DIR}"
EXPERIENCE_FILE="${EXPERIENCE_FILE:-experience.md}"
RL_DIR="${RL_DIR:-$STATE_DIR/rl}"
RL_POLICY_FILE="${RL_POLICY_FILE:-rl_policy.json}"
RL_METRICS_FILE="${RL_METRICS_FILE:-rl_metrics.json}"
RL_HISTORY_FILE="${RL_HISTORY_FILE:-rl_history.jsonl}"

STATE_PATH="$(resolve_path "$STATE_DIR")"
JOURNAL_PATH="$(resolve_path "$JOURNAL_DIR")"
LOG_PATH="$(resolve_path "$LOG_DIR")"
IDENTITY_PATH="$(resolve_path "$IDENTITY_DIR")"
EXPERIENCE_PATH="$(resolve_path "$EXPERIENCE_DIR")"
RL_PATH="$(resolve_path "$RL_DIR")"

rm_path() {
  local path="$1"
  if [ -e "$path" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "[dry-run] remove $path"
    else
      rm -rf "$path"
      echo "removed $path"
    fi
  fi
}

clean_dir_contents() {
  local dir="$1"
  if [ -d "$dir" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      find "$dir" -mindepth 1 -print
    else
      find "$dir" -mindepth 1 -exec rm -rf {} +
      echo "cleared $dir"
    fi
  fi
}

clean_dir_contents_except() {
  local dir="$1"
  shift
  local keep_paths=("$@")
  if [ ! -d "$dir" ]; then
    return
  fi
  if [ "${#keep_paths[@]}" -eq 0 ]; then
    clean_dir_contents "$dir"
    return
  fi
  local find_expr=()
  for keep in "${keep_paths[@]}"; do
    find_expr+=( -path "$keep" -o )
  done
  unset 'find_expr[${#find_expr[@]}-1]'
  if [ "$DRY_RUN" -eq 1 ]; then
    find "$dir" -mindepth 1 \( "${find_expr[@]}" \) -prune -o -print
  else
    find "$dir" -mindepth 1 \( "${find_expr[@]}" \) -prune -o -exec rm -rf {} +
    echo "cleared $dir (kept experience/rl)"
  fi
}

clean_journal() {
  local dir="$1"
  if [ -d "$dir" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      find "$dir" -type f ! -name "README.md" -print
    else
      find "$dir" -type f ! -name "README.md" -delete
      echo "cleared $dir (kept README.md)"
    fi
  fi
}

# 运行记录与生成文件
clean_dir_contents "$LOG_PATH"
clean_dir_contents_except "$STATE_PATH" \
  "$EXPERIENCE_PATH/$EXPERIENCE_FILE" \
  "$RL_PATH" \
  "$RL_PATH/$RL_POLICY_FILE" \
  "$RL_PATH/$RL_METRICS_FILE" \
  "$RL_PATH/$RL_HISTORY_FILE"
clean_journal "$JOURNAL_PATH"

# 上次实验生成的脚本/输出
rm_path "$ROOT_DIR/creative_brief.md"
rm_path "$ROOT_DIR/interactive_engine.py"
rm_path "$ROOT_DIR/neon_architect_master.py"
rm_path "$ROOT_DIR/neon_walker_dynamic.py"

if [ "$REMOVE_ALL" -eq 1 ]; then
  rm_path "$ROOT_DIR/node_modules"
  rm_path "$ROOT_DIR/.venv"
fi

if [ "$RESTART_ALL" -eq 1 ]; then
  rm_path "$IDENTITY_PATH/$IDENTITY_A_FILE"
  rm_path "$IDENTITY_PATH/$IDENTITY_B_FILE"
  rm_path "$EXPERIENCE_PATH/$EXPERIENCE_FILE"
  rm_path "$RL_PATH"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 完成预览。"
else
  echo "清理完成。"
fi
