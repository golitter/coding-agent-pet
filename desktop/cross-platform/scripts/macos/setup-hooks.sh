#!/bin/bash
# Configure Claude Code / Codex / OpenCode hooks for Kotori Pet.
set -euo pipefail

# 项目根目录（cross-platform，hooks/ 与会话目录所在地）
PLATFORM_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON_BIN="/usr/bin/python3"

"$PYTHON_BIN" "$PLATFORM_DIR/hooks/scripts/setup_hooks.py" "$PLATFORM_DIR"
