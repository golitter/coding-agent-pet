#!/bin/bash
# Configure Claude Code / Codex / OpenCode hooks inside WSL2 for the Windows Kotori Pet renderer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PYTHON_BIN="${KOTORI_PET_PYTHON:-python3}"
ENDPOINT="tcp://127.0.0.1:17361"

if ! grep -qi microsoft /proc/version 2>/dev/null && [ -z "${WSL_DISTRO_NAME:-}" ] && [ -z "${WSL_INTEROP:-}" ]; then
  echo "[setup-hooks:wsl] This entrypoint is intended to run inside WSL2." >&2
  echo "                  For native Linux/macOS, use scripts/macos/setup-hooks.sh." >&2
  exit 1
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[setup-hooks:wsl] Python 3 was not found: $PYTHON_BIN" >&2
  echo "                  Install python3 in WSL or set KOTORI_PET_PYTHON." >&2
  exit 1
fi

echo "Kotori Pet WSL2 hook setup"
echo "  platform: $PLATFORM_DIR"
echo "  python:   $PYTHON_BIN"
echo "  endpoint: $ENDPOINT"
echo ""
echo "Make sure the Windows Kotori Pet app is running; WSL hooks/plugins will push events to $ENDPOINT."
echo ""

"$PYTHON_BIN" - <<'PY'
import socket

try:
    with socket.create_connection(("127.0.0.1", 17361), timeout=0.2):
        print("[setup-hooks:wsl] Connectivity check: Windows pet endpoint is reachable.")
except OSError:
    print("[setup-hooks:wsl] Connectivity check: endpoint is not reachable right now.")
    print("                  Start the Windows pet app before using Claude Code/Codex/OpenCode.")
    print("                  If it is already running, WSL may need mirrored networking for localhost.")
    print("")
PY

KOTORI_PET_PYTHON="$PYTHON_BIN" "$PYTHON_BIN" "$PLATFORM_DIR/hooks/scripts/setup_hooks.py" "$PLATFORM_DIR"
