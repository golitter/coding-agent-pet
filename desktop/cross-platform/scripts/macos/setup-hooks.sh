#!/bin/bash
# Configure Claude Code / Codex / OpenCode hooks for Kotori Pet.
set -euo pipefail

# shellcheck source=desktop/cross-platform/scripts/macos/common.sh
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

"$PYTHON_BIN" "$PLATFORM_DIR/hooks/scripts/setup_hooks.py" "$PLATFORM_DIR"
