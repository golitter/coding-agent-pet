"""Claude Code pet hook entry.

Reads event JSON from stdin (provided by Claude Code's hook system),
extracts fields using Claude Code's schema, and delegates to common.process_event.
"""

import json
import os
import sys
from pathlib import Path

# Allow `import common` whether invoked as a script or module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import process_event  # noqa: E402


def main():
    # desktop/cross-platform/hooks/scripts/ → desktop/cross-platform/
    platform_dir = str(Path(__file__).resolve().parent.parent.parent)

    # ── Read stdin ──
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    # Claude Code uses 'hook_event_name'
    hook_event = input_data.get('hook_event_name', '') or ''
    session_id = input_data.get('session_id', 'unknown') or 'unknown'
    tool_name  = input_data.get('tool_name', '') or ''
    cwd        = input_data.get('cwd', '') or ''

    process_event(
        platform_dir=platform_dir,
        source='claude-code',
        hook_event=hook_event,
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
    )


if __name__ == '__main__':
    main()
