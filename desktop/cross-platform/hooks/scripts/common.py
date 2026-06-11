"""Shared helpers for pet hook scripts."""

import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_STATE = {'state': 'idle', 'dialogue': ''}
POST_TOOL_STATE = {'state': 'running', 'dialogue': '处理中...'}


def exit_quietly(output=None):
    """Exit without surfacing hook errors to the parent tool."""
    if output is not None:
        print(output)
    sys.exit(0)


def read_stdin_json(fallback_output=None):
    """Read JSON from stdin; exit quietly when the hook payload is unusable."""
    try:
        return json.load(sys.stdin)
    except Exception:
        exit_quietly(fallback_output)


def first_present(payload, *keys, default=''):
    """Return the first non-empty value among candidate keys."""
    for key in keys:
        value = payload.get(key)
        if value not in (None, ''):
            return value
    return default


def platform_dir_from_script(script_file):
    """Resolve desktop/cross-platform from hooks/scripts/*.py."""
    return str(Path(script_file).resolve().parent.parent.parent)


def load_json_file(path):
    with open(path, 'r') as file_obj:
        return json.load(file_obj)


def load_config(platform_dir):
    """Load config.json, falling back to config.example.json."""
    platform_path = Path(platform_dir).resolve()
    repo_root = platform_path.parent.parent

    config_path = platform_path / 'config.json'
    if not config_path.exists():
        config_path = platform_path / 'config.example.json'

    try:
        config = load_json_file(config_path)
    except Exception as exc:
        print(f'[pet-hook] Cannot load config {config_path}: {exc}', file=sys.stderr)
        exit_quietly()

    return config, str(repo_root)


def resolve_path(config_value, repo_root, *fallback_parts):
    """Resolve configured paths relative to repo root when needed."""
    if isinstance(config_value, str) and config_value.strip():
        expanded = os.path.expanduser(config_value)
        if os.path.isabs(expanded):
            return expanded
        return str(Path(repo_root) / expanded)
    return str(Path(repo_root).joinpath(*fallback_parts))


def atomic_write_json(path, payload):
    """Write JSON atomically via a temp file."""
    tmp_path = f'{path}.tmp'
    with open(tmp_path, 'w') as file_obj:
        json.dump(payload, file_obj, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def write_session(session_file, payload):
    """Best-effort session file update."""
    try:
        atomic_write_json(session_file, payload)
    except Exception:
        pass


def push_socket(socket_path, payload):
    """Best-effort push of payload JSON to Unix socket."""
    try:
        if not os.path.exists(socket_path):
            return
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(0.1)
        sock.connect(socket_path)
        sock.sendall(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
        sock.close()
    except Exception:
        pass


def resolve_state(hook_event, state_map):
    """Map a hook event to pet state and dialogue."""
    if hook_event == 'PostToolUse':
        return POST_TOOL_STATE.copy()
    return dict(state_map.get(hook_event, DEFAULT_STATE))


def append_debug_log(log_path, **fields):
    if not log_path:
        return
    try:
        with open(log_path, 'a') as log_file:
            log_file.write(json.dumps(fields, ensure_ascii=False) + '\n')
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

    pet_id = config.get('pet_id', 'kotori-minami')
    sessions_dir = resolve_path(
        config.get('sessions_dir'),
        repo_root,
        'desktop',
        'cross-platform',
        'runtime',
        'sessions',
    )
    socket_path = config.get('socket_path') or '/tmp/kotori-pet.sock'
    state_map = config.get('state_map', {})
    terminal_events = set(config.get('terminal_events', ['StopFailure']))

    os.makedirs(sessions_dir, exist_ok=True)

    state_info = resolve_state(hook_event, state_map)
    pet_state = state_info.get('state', 'idle')
    dialogue = state_info.get('dialogue', '')

    is_terminal = hook_event in terminal_events

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

    append_debug_log(
        log_path,
        time=datetime.now(timezone.utc).isoformat(),
        event=hook_event,
        session_id=session_id,
        state=pet_state,
        dialogue=dialogue,
        socket_exists=os.path.exists(socket_path),
        sessions_dir=sessions_dir,
    )

    session_file = os.path.join(sessions_dir, session_id + '.json')
    write_session(session_file, payload)
    push_socket(socket_path, payload)
