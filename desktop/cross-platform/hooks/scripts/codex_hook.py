"""Codex pet hook entry."""

import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402, I001
    exit_quietly,
    first_present,
    platform_dir_from_script,
    process_event,
    read_stdin_json,
)


# Codex hook configs use snake_case event ids, while the shared pet config
# keeps Claude-style event names. Map both shapes so either input works.
EVENT_ALIASES = {
    'notification':        'Notification',
    'permission_request':  'PermissionRequest',
    'post_tool_use':       'PostToolUse',
    'pre_tool_use':        'PreToolUse',
    'session_start':       'SessionStart',
    'stop':                'Stop',
    'stop_failure':        'StopFailure',
    'subagent_stop':       'SubagentStop',
    'user_prompt_submit':  'UserPromptSubmit',
}


def main():
    platform_dir = platform_dir_from_script(__file__)
    input_data = read_stdin_json(fallback_output='{}')
    log_path = str(Path(platform_dir) / 'runtime' / 'hook-events.log')

    raw_event = first_present(
        input_data,
        'hook_event_name',
        'hookEventName',
        'event',
        'codex_event_type',
        'codexEventType',
    )
    hook_event = EVENT_ALIASES.get(raw_event, raw_event) or ''

    process_event(
        platform_dir=platform_dir,
        source='codex',
        hook_event=hook_event,
        session_id=first_present(
            input_data,
            'session_id',
            'sessionId',
            'conversation_id',
            'thread_id',
            default='unknown',
        ),
        tool_name=first_present(input_data, 'tool_name', 'tool', 'toolName'),
        cwd=first_present(input_data, 'cwd'),
        extra_context={'raw_event': raw_event},
        log_path=log_path,
    )

    exit_quietly('{}')


if __name__ == '__main__':
    main()
