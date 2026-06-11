#!/bin/bash
# Kotori Minami pet state hook (Claude Code / Codex)
# Usage: pet-hook.sh <claude-code|codex>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="${1:-claude-code}"

case "$SOURCE" in
    claude-code) /usr/bin/python3 "$SCRIPT_DIR/scripts/claude_hook.py" || true ;;
    codex)       /usr/bin/python3 "$SCRIPT_DIR/scripts/codex_hook.py" || true ;;
    *)           echo "Unknown source: $SOURCE" >&2; exit 1 ;;
esac
