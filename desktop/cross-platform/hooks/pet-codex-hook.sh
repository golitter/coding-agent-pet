#!/bin/bash
# Kotori Minami pet state hook for Codex
# Reads event JSON from stdin, delegates to scripts/codex_hook.py.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
/usr/bin/python3 "$SCRIPT_DIR/scripts/codex_hook.py" || true
