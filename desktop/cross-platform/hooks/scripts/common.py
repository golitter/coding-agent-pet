"""Shared logic for Claude Code / Codex pet hooks.

Both hook entry scripts (claude_hook.py, codex_hook.py) call into this module
to avoid duplicating the ~130 lines of config loading, session file management,
and socket push logic.
"""

import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path


def load_config(platform_dir):
    """Load config.json (or fallback to config.example.json).

    Returns: (config_dict, repo_root_path)
    """
    platform_dir = Path(platform_dir).resolve()
    repo_root = platform_dir.parent.parent  # desktop/cross-platform → repo root

    config_path = str(platform_dir / 'config.json')
    if not os.path.exists(config_path):
        config_path = str(platform_dir / 'config.example.json')

    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
    except Exception as e:
        print(f'[pet-hook] Cannot load config {config_path}: {e}', file=sys.stderr)
        sys.exit(0)

    return config, str(repo_root)


def resolve(config_val, repo_root, *auto_parts):
    """Resolve a path: use config value if non-null string, else join auto_parts from repo root."""
    if config_val is not None and isinstance(config_val, str) and config_val.strip():
        p = os.path.expanduser(config_val)
        if os.path.isabs(p):
            return p
        return str(Path(repo_root) / p)
    return str(Path(repo_root).joinpath(*auto_parts))


def write_session(session_file, payload):
    """Atomic write of session JSON: write to .tmp then rename."""
    try:
        tmp_file = session_file + '.tmp'
        with open(tmp_file, 'w') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_file, session_file)
    except Exception:
        # Best-effort — hook failures must not block the AI tool
        pass


def push_socket(socket_path, payload):
    """Best-effort push of payload JSON to Unix socket. Silent on failure."""
    try:
        if os.path.exists(socket_path):
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(0.1)
            sock.connect(socket_path)
            sock.sendall(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
            sock.close()
    except Exception:
        pass


def process_event(platform_dir, source, hook_event, session_id, tool_name,
                  cwd='', extra_context=None, log_path=None):
    """End-to-end processing of a hook event.

    Args:
        platform_dir:  Path to desktop/cross-platform/
        source:        'claude-code' or 'codex'
        hook_event:    Normalized event name (PascalCase, e.g. 'PreToolUse')
        session_id:    Session identifier
        tool_name:     Tool name from hook input (may be empty)
        cwd:           Working directory from hook input (may be empty)
        extra_context: Additional fields for the payload context
        log_path:      If set, append a debug line to this file
    """
    config, repo_root = load_config(platform_dir)

    pet_id           = config.get('pet_id', 'kotori-minami')
    sessions_dir     = resolve(config.get('sessions_dir'), repo_root,
                                'desktop', 'cross-platform', 'runtime', 'sessions')
    socket_path      = config.get('socket_path') or '/tmp/kotori-pet.sock'
    state_map        = config.get('state_map', {})
    terminal_events  = set(config.get('terminal_events', ['StopFailure']))

    os.makedirs(sessions_dir, exist_ok=True)

    # ── Resolve state and dialogue ──
    if hook_event == 'PostToolUse':
        pet_state = 'running'
        dialogue  = '处理中...'
    else:
        mapping   = state_map.get(hook_event, {'state': 'idle', 'dialogue': ''})
        pet_state = mapping.get('state', 'idle')
        dialogue  = mapping.get('dialogue', '')

    is_terminal = hook_event in terminal_events

    # ── Build payload ──
    context = {
        'cwd':       cwd,
        'tool_name': tool_name,
    }
    if extra_context:
        context.update(extra_context)

    payload = {
        'petId':      pet_id,
        'state':      pet_state,
        'dialogue':   dialogue,
        'event':      hook_event,
        'source':     source,
        'session_id': session_id,
        'updatedAt':  datetime.now(timezone.utc).isoformat(),
        'isTerminal': is_terminal,
        'context':    context,
    }

    # ── Debug log (optional) ──
    if log_path:
        try:
            with open(log_path, 'a') as log:
                log.write(json.dumps({
                    'time':          datetime.now(timezone.utc).isoformat(),
                    'event':         hook_event,
                    'session_id':    session_id,
                    'state':         pet_state,
                    'dialogue':      dialogue,
                    'socket_exists': os.path.exists(socket_path),
                    'sessions_dir':  sessions_dir,
                }, ensure_ascii=False) + '\n')
        except Exception:
            pass

    # ── Session file lifecycle ──
    session_file = os.path.join(sessions_dir, session_id + '.json')

    # Delayed cleanup after Stop/terminal events is handled by the Rust backend
    # (ActivityAggregator schedules the removal on receiving this payload), NOT here.
    # Hook scripts are short-lived processes — a threading.Timer here would be
    # killed when the process exits, before it could ever fire.
    write_session(session_file, payload)

    # ── Best-effort socket push ──
    push_socket(socket_path, payload)
