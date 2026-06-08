#!/bin/bash
# Kotori Minami pet state hook for Claude Code
# Reads event JSON from stdin, delegates to scripts/claude_hook.py.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
/usr/bin/python3 "$SCRIPT_DIR/scripts/claude_hook.py" || true
