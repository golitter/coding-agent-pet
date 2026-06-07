#!/bin/bash
# Kotori Minami pet state hook for Codex
# Reads event JSON from stdin, maps to pet animation state, writes session file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../config.json"

/usr/bin/python3 -c "
import json, os, socket, sys, subprocess
from datetime import datetime, timezone
from pathlib import Path

# ── Auto-detect directories ──
MAC_DIR = Path('$SCRIPT_DIR').parent.resolve()
REPO_ROOT = MAC_DIR.parent.parent

# ── Load config (config.json or config.example.json) ──
config_path = str(MAC_DIR / 'config.json')
if not os.path.exists(config_path):
    config_path = str(MAC_DIR / 'config.example.json')

try:
    with open(config_path, 'r') as f:
        config = json.load(f)
except Exception as e:
    print(f'[pet-hook] Cannot load config {config_path}: {e}', file=sys.stderr)
    sys.exit(0)

# Resolve paths: null → auto-detect from repo root
def resolve(config_val, *auto_parts):
    if config_val is not None and isinstance(config_val, str) and config_val.strip():
        p = os.path.expanduser(config_val)
        if os.path.isabs(p):
            return p
        return str(REPO_ROOT / p)
    return str(REPO_ROOT.joinpath(*auto_parts))

pet_base_dir = resolve(config.get('pet_base_dir'))
pet_id       = config.get('pet_id', 'kotori-minami')
sessions_dir = resolve(config.get('sessions_dir'), 'desktop', 'mac', 'runtime', 'sessions')
socket_path  = config.get('socket_path') or '/tmp/kotori-pet.sock'
state_map    = config.get('state_map', {})
tool_dialogue = config.get('tool_dialogue', {})
terminal_events = set(config.get('terminal_events', ['StopFailure', 'SessionEnd']))

os.makedirs(sessions_dir, exist_ok=True)

# ── Read stdin ──
try:
    input_data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

# Codex uses 'event' field
hook_event = input_data.get('event', '') or ''
session_id  = input_data.get('session_id', 'unknown') or 'unknown'
tool_name   = input_data.get('tool_name', '') or ''

# ── Resolve state and dialogue ──
if hook_event == 'PostToolUse':
    mapping = tool_dialogue.get(tool_name, {'state': 'idle', 'dialogue': ''})
    pet_state = mapping.get('state', 'idle')
    dialogue  = mapping.get('dialogue', '')
else:
    mapping = state_map.get(hook_event, {'state': 'idle', 'dialogue': ''})
    pet_state = mapping.get('state', 'idle')
    dialogue  = mapping.get('dialogue', '')

is_terminal = hook_event in terminal_events

# ── Build payload ──
payload = {
    'petId':      pet_id,
    'state':      pet_state,
    'dialogue':   dialogue,
    'event':      hook_event,
    'source':     'codex',
    'session_id': session_id,
    'updatedAt':  datetime.now(timezone.utc).isoformat(),
    'isTerminal': is_terminal,
    'context': {
        'cwd':       input_data.get('cwd', ''),
        'tool_name': tool_name,
    },
}

session_file = os.path.join(sessions_dir, session_id + '.json')

# ── For SessionEnd: delete immediately ──
if hook_event == 'SessionEnd':
    try:
        os.remove(session_file)
    except FileNotFoundError:
        pass
else:
    # ── Atomic write session file ──
    tmp_file = session_file + '.tmp'
    try:
        with open(tmp_file, 'w') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, session_file)
    except Exception:
        pass

    # ── Schedule async deletion for terminal events or Stop ──
    if is_terminal or hook_event == 'Stop':
        delay = 2 if hook_event == 'Stop' else 3
        try:
            subprocess.Popen(
                ['nohup', '/bin/bash', '-c',
                 'sleep ' + str(delay) + ' && rm -f \"' + session_file + '\"'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                preexec_fn=os.setpgrp,
            )
        except Exception:
            pass

# ── Best-effort socket push ──
try:
    if os.path.exists(socket_path):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(0.1)
        sock.connect(socket_path)
        sock.sendall(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
        sock.close()
except Exception:
    pass
" || true
