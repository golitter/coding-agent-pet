"""Claude Code pet hook entry."""

import os
import sys

# Allow `import common` whether invoked as a script or module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402, I001
    first_present,
    platform_dir_from_script,
    process_event,
    read_stdin_json,
)


def main():
    platform_dir = platform_dir_from_script(__file__)
    input_data = read_stdin_json()

    process_event(
        platform_dir=platform_dir,
        source='claude-code',
        hook_event=first_present(input_data, 'hook_event_name'),
        session_id=first_present(input_data, 'session_id', default='unknown'),
        tool_name=first_present(input_data, 'tool_name'),
        cwd=first_present(input_data, 'cwd'),
    )


if __name__ == '__main__':
    main()
