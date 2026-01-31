#!/usr/bin/env bash
# 清理运行记录与生成文件，仅保留 git 跟踪的原始代码文件。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
用法: scripts/clean-runtime.sh [--dry-run] [--all]

  --dry-run  仅显示将要删除的内容，不执行删除
  --all      额外删除依赖/虚拟环境（node_modules/、.venv/）
USAGE
}

DRY_RUN=0
REMOVE_ALL=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --all)
      REMOVE_ALL=1
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
clean_dir_contents "$ROOT_DIR/logs"
clean_dir_contents "$ROOT_DIR/state"
clean_journal "$ROOT_DIR/journal"

# 上次实验生成的脚本/输出
rm_path "$ROOT_DIR/creative_brief.md"
rm_path "$ROOT_DIR/interactive_engine.py"
rm_path "$ROOT_DIR/neon_architect_master.py"
rm_path "$ROOT_DIR/neon_walker_dynamic.py"

if [ "$REMOVE_ALL" -eq 1 ]; then
  rm_path "$ROOT_DIR/node_modules"
  rm_path "$ROOT_DIR/.venv"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 完成预览。"
else
  echo "清理完成。"
fi
