"""Codex pet hook entry.

Reads event JSON from stdin (provided by Codex's hook system),
extracts fields using Codex's schema (with snake_case aliases),
and delegates to common.process_event.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import process_event  # noqa: E402


# Codex hook configs use snake_case event ids, while the shared pet config
# keeps Claude-style event names. Map both shapes so either input works.
EVENT_ALIASES = {
    'notification':        'Notification',
    'permission_request':  'PermissionRequest',
    'post_tool_use':       'PostToolUse',
    'pre_tool_use':        'PreToolUse',
    'session_end':         'SessionEnd',
    'session_start':       'SessionStart',
    'stop':                'Stop',
    'stop_failure':        'StopFailure',
    'subagent_stop':       'SubagentStop',
    'user_prompt_submit':  'UserPromptSubmit',
}


def main():
    platform_dir = str(Path(__file__).resolve().parent.parent.parent)

    # ── Read stdin ──
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        # Codex command hooks expect JSON-ish stdout even on failure
        print('{}')
        sys.exit(0)

    # Codex accepts several event field names
    raw_event = (
        input_data.get('hook_event_name')
        or input_data.get('event')
        or input_data.get('codex_event_type')
        or ''
    )
    hook_event = EVENT_ALIASES.get(raw_event, raw_event) or ''

    # Session ID: try multiple field shapes
    session_id = (
        input_data.get('session_id')
        or input_data.get('sessionId')
        or input_data.get('conversation_id')
        or input_data.get('thread_id')
        or 'unknown'
    )

    tool_name = input_data.get('tool_name') or input_data.get('tool') or ''
    cwd       = input_data.get('cwd', '') or ''

    process_event(
        platform_dir=platform_dir,
        source='codex',
        hook_event=hook_event,
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
        extra_context={'raw_event': raw_event},
        log_path='/tmp/kotori-pet-codex-hook.log',
    )

    # Codex command hooks expect JSON-ish stdout for some events
    print('{}')


if __name__ == '__main__':
    main()
