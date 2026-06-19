#!/bin/bash
# 南琴梨（Kotori Minami）宠物状态 hook 入口。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="${1:-claude-code}"
PYTHON_BIN="${KOTORI_PET_PYTHON:-/usr/bin/python3}"

run_hook() {
    local script_name="$1"
    "$PYTHON_BIN" "$SCRIPT_DIR/scripts/$script_name" || true
}

case "$SOURCE" in
    claude-code)
        run_hook "claude_hook.py"
        ;;
    codex)
        run_hook "codex_hook.py"
        ;;
    *)
        echo "Unsupported hook source: $SOURCE" >&2
        exit 1
        ;;
esac
