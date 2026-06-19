#!/bin/bash
# 为 Kotori Pet 配置 Claude Code / Codex / OpenCode hooks。
set -euo pipefail

# shellcheck source=desktop/cross-platform/scripts/macos/common.sh
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

"$PYTHON_BIN" "$PLATFORM_DIR/hooks/scripts/setup_hooks.py" "$PLATFORM_DIR"
