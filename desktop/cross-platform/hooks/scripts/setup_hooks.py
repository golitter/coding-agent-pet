"""Configure pet hooks for Claude Code, Codex, and OpenCode."""

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

CLAUDE_EVENTS = [
    'Notification', 'PermissionRequest', 'PostToolUse', 'PreCompact',
    'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure',
    'SubagentStop', 'UserPromptSubmit',
]

CODEX_EVENTS = [
    'Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse',
    'SessionStart', 'Stop', 'StopFailure', 'SubagentStop', 'UserPromptSubmit',
]

LEGACY_HOOK_FRAGMENTS = [
    'kotori-desktop-pet/hooks/pet-claude-hook.sh',
    'kotori-desktop-pet/hooks/pet-codex-hook.sh',
    'desktop/mac/hooks/pet-claude-hook.sh',
    'desktop/mac/hooks/pet-codex-hook.sh',
    'hooks/pet-claude-hook.sh',
    'hooks/pet-codex-hook.sh',
    'pet-hook.sh claude-code',
    'pet-hook.sh codex',
    'pet-codex-hook.sh',
    'claude_hook.py',
    'codex_hook.py',
]


@dataclass(frozen=True)
class HookTarget:
    name: str
    settings_path: str
    command: str
    events: list[str]
    executable_names: list[str]
    command_windows: Optional[str] = None


def is_windows():
    return os.name == 'nt'


def is_wsl():
    if os.environ.get('WSL_DISTRO_NAME') or os.environ.get('WSL_INTEROP'):
        return True
    try:
        return 'microsoft' in Path('/proc/version').read_text(encoding='utf-8').lower()
    except OSError:
        return False


def load_json(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8') as file_obj:
            return json.load(file_obj)
    except FileNotFoundError:
        return {} if default is None else default


def atomic_write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f'{path}.tmp'
    try:
        with open(tmp_path, 'w', encoding='utf-8') as file_obj:
            file_obj.write(content)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def atomic_write_json(path, payload):
    atomic_write(path, json.dumps(payload, indent=2, ensure_ascii=False))


def load_app_config(platform_dir):
    config_path = platform_dir / 'config.json'
    example_path = platform_dir / 'config.example.json'

    if config_path.exists():
        return load_json(config_path), config_path
    if example_path.exists():
        return load_json(example_path), example_path

    print('[setup-hooks] No config found', flush=True)
    sys.exit(1)


def quote_command_part(value):
    text = str(value)
    if re.search(r'\s|"', text):
        return '"' + text.replace('"', '\\"') + '"'
    return text


def split_command(command):
    return command.split()


def to_forward_slash(path):
    """Convert backslashes to forward slashes.

    Claude Code/Codex execute hooks via sh on Windows, where backslashes are
    escape characters and silently mangle D:\\path\\to\\exe into D:pathtoexe.
    Forward slashes parse correctly under both sh and cmd.
    """
    return str(path).replace('\\', '/')


def validate_python_command(command):
    """Return True if `command` launches a working Python 3 interpreter.

    Actually runs `<command> --version` (rather than just trusting
    shutil.which / Get-Command) so we catch App Execution Alias stubs that
    'exist' on PATH but open the Microsoft Store instead of running python,
    and broken absolute paths. This is the gate that lets us fail loudly
    BEFORE writing an unusable hook into settings.json.
    """
    parts = split_command(command)
    if not parts:
        return False
    if not shutil.which(parts[0]) and not os.path.isabs(parts[0]):
        # Bare name not on PATH and not an absolute path → can't resolve.
        return False
    if os.path.isabs(parts[0]) and not os.path.exists(parts[0]):
        return False
    try:
        result = subprocess.run(
            parts + ['--version'],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    # python 2 prints to stderr; python 3 prints "Python 3.x" to stdout (or
    # stderr on some builds). Accept either, but reject Python 2.
    combined = (result.stdout + result.stderr).decode('utf-8', 'replace')
    return 'Python 3' in combined or combined.strip().startswith('3.')


def detect_python_command(config_value=None):
    """Resolve and validate the python command to embed in hook configs.

    Two modes, both validated via validate_python_command():

    1. Explicit (the KOTORI_PET_PYTHON env var, or ``hooks.python_command``
       in config.json): the user pins the exact command. This is
       the recommended path on Windows — it sidesteps conda/PATH drift (a
       hook written while conda base was active would otherwise hardcode the
       conda python's absolute path and break on the next env switch). If the
       pinned command fails validation, we exit with a clear error rather
       than silently writing a dead hook.

    2. Auto-detect (config value empty): probe candidate bare names and pick
       the first that validates. Bare names are portable across python
       upgrades, at the cost of depending on PATH containing python when the
       hook runs.

    Returns the validated command string (bare name or forward-slashed
    path), or None when auto-detect finds nothing.
    """
    explicit = (os.environ.get('KOTORI_PET_PYTHON') or config_value or '').strip()
    if explicit:
        if not validate_python_command(explicit):
            print(f'[setup-hooks] ERROR: configured python_command does not work: {explicit!r}', file=sys.stderr)
            print('              `<command> --version` did not return Python 3.', file=sys.stderr)
            print('              Fix KOTORI_PET_PYTHON or hooks.python_command in config.json,', file=sys.stderr)
            print('              then rerun setup.', file=sys.stderr)
            sys.exit(1)
        return to_forward_slash(explicit) if os.path.isabs(explicit) else explicit

    candidates = ('python', 'py -3', 'python3') if is_windows() else ('python3', 'python')
    for candidate in candidates:
        if validate_python_command(candidate):
            return candidate
    return None


def build_command(parts):
    return ' '.join(quote_command_part(part) for part in parts)


def default_claude_settings():
    override = os.environ.get('CLAUDE_CONFIG_DIR')
    if override:
        return str(Path(override).expanduser() / 'settings.json')
    return str(Path('~/.claude/settings.json').expanduser())


def default_codex_hooks():
    override = os.environ.get('CODEX_HOME')
    if override:
        return str(Path(override).expanduser() / 'hooks.json')
    return str(Path('~/.codex/hooks.json').expanduser())


def default_opencode_plugins_dir():
    override = os.environ.get('OPENCODE_CONFIG_DIR')
    if override:
        return str(Path(override).expanduser() / 'plugins')
    return str(Path('~/.config/opencode/plugins').expanduser())


def config_path_or_default(value, default_value):
    if isinstance(value, str) and value.strip():
        return os.path.expanduser(value)
    return default_value


def is_tool_available(names):
    return any(shutil.which(name) for name in names)


def should_setup_opencode():
    return os.environ.get('KOTORI_PET_SKIP_OPENCODE') not in ('1', 'true', 'TRUE', 'yes')


def is_managed_pet_command(command, expected_command):
    fragments = LEGACY_HOOK_FRAGMENTS + [expected_command]
    return any(fragment in command for fragment in fragments)


def filter_out_pet_hooks(entries, expected_command):
    cleaned_entries = []
    for entry in entries:
        hooks = entry.get('hooks', [])
        managed_hook_found = any(
            is_managed_pet_command(hook.get('command', ''), expected_command)
            or is_managed_pet_command(hook.get('commandWindows', ''), expected_command)
            or is_managed_pet_command(hook.get('command_windows', ''), expected_command)
            for hook in hooks
        )
        if not managed_hook_found:
            cleaned_entries.append(entry)
    return cleaned_entries


def install_event_hooks(settings, target):
    hooks_section = settings.setdefault('hooks', {})

    for event_name, entries in list(hooks_section.items()):
        hooks_section[event_name] = filter_out_pet_hooks(entries, target.command)

    for event_name in target.events:
        hook = {
            'command': target.command,
            'type': 'command',
        }
        if target.command_windows:
            hook['commandWindows'] = target.command_windows
        hooks_section.setdefault(event_name, []).append({'hooks': [hook]})


def setup_platform(target):
    print(f'Updating {target.name} hooks...')
    settings = load_json(target.settings_path, default={})
    install_event_hooks(settings, target)
    atomic_write_json(target.settings_path, settings)
    print(f'  Wrote {len(target.events)} events to {target.settings_path}')
    return target.name, target.settings_path


def normalize_codex_event(event_name):
    """Codex stores hook trust state with snake_case event ids."""
    return re.sub(r'(?<!^)([A-Z])', r'_\1', event_name).lower()


def codex_hooks_state_path(settings_path):
    """Return the path shape Codex uses in [hooks.state] keys."""
    return str(Path(settings_path).expanduser()).replace('/.Codex/', '/.codex/')


def load_codex_pet_hook_positions(settings_path, hook_cmd, events):
    """Find matcher/hook indexes for this exact pet hook command."""
    try:
        settings = load_json(settings_path, default={})
    except json.JSONDecodeError:
        settings = {}

    positions = {}
    for event_name in events:
        event_positions = []
        for matcher_index, matcher_group in enumerate(settings.get('hooks', {}).get(event_name, [])):
            for hook_index, hook in enumerate(matcher_group.get('hooks', [])):
                if hook.get('command') == hook_cmd:
                    event_positions.append((matcher_index, hook_index))
        positions[event_name] = event_positions
    return positions


def find_toml_section(text, header):
    """Return (start, body_start, end) for a TOML section header."""
    start = text.find(header)
    if start < 0:
        return None
    line_end = text.find('\n', start)
    if line_end < 0:
        return start, len(text), len(text)
    body_start = line_end + 1
    next_header = text.find('\n[', body_start)
    end = len(text) if next_header < 0 else next_header + 1
    return start, body_start, end


def codex_hook_state_key(settings_path, event_name, matcher_index, hook_index):
    event_id = normalize_codex_event(event_name)
    return f'{codex_hooks_state_path(settings_path)}:{event_id}:{matcher_index}:{hook_index}'


def enable_codex_pet_hooks(settings_path, hook_cmd, events):
    """Auto-enable already trusted Codex pet hook state entries."""
    config_toml = Path(settings_path).with_name('config.toml')
    try:
        text = config_toml.read_text(encoding='utf-8')
    except OSError:
        return

    positions = load_codex_pet_hook_positions(settings_path, hook_cmd, events)
    enabled_count = 0

    for event_name, event_positions in positions.items():
        for matcher_index, hook_index in event_positions:
            key = codex_hook_state_key(settings_path, event_name, matcher_index, hook_index)
            header = f'[hooks.state."{key}"]'
            section = find_toml_section(text, header)
            if not section:
                continue

            _start, body_start, end = section
            body = text[body_start:end]
            if 'enabled = true' in body or 'trusted_hash' not in body:
                continue

            new_body = re.sub(
                r'(?m)^(trusted_hash\s*=\s*".*")[ \t]*$',
                r'\1\nenabled = true',
                body,
                count=1,
            )
            if new_body == body:
                continue
            text = text[:body_start] + new_body + text[end:]
            enabled_count += 1

    if enabled_count == 0:
        return

    atomic_write(str(config_toml), text)
    print(f'  Auto-enabled {enabled_count} trusted Codex hook state entries')


def warn_untrusted_codex_hooks(settings_path, hook_cmd, events):
    """Best-effort diagnostic for Codex's review/trust gate."""
    config_toml = str(Path(settings_path).with_name('config.toml'))
    try:
        text = Path(config_toml).read_text(encoding='utf-8')
    except OSError:
        print('  Codex config.toml does not exist yet; run Codex once, then trust the pet hook in /hooks.')
        return

    positions = load_codex_pet_hook_positions(settings_path, hook_cmd, events)
    missing = []

    for event_name, event_positions in positions.items():
        event_enabled = False
        for matcher_index, hook_index in event_positions:
            key = codex_hook_state_key(settings_path, event_name, matcher_index, hook_index)
            header = f'[hooks.state."{key}"]'
            section = find_toml_section(text, header)
            if not section:
                continue
            _start, body_start, end = section
            body = text[body_start:end]
            if 'enabled = true' in body:
                event_enabled = True
                break
        if event_positions and not event_enabled:
            missing.append(event_name)

    if missing:
        print('  Codex hook was written, but these events are not enabled/trusted yet:')
        print('    ' + ', '.join(missing))
        print('    In Codex, run /hooks and Trust/Enable this command:')
        print(f'    {hook_cmd}')


def setup_opencode(platform_dir, hooks_config):
    """Deploy OpenCode plugin + companion config file."""
    opencode_plugins_dir = config_path_or_default(
        hooks_config.get('opencode_plugins_dir'),
        default_opencode_plugins_dir(),
    )
    src_plugin = str(platform_dir / 'hooks' / 'opencode-plugin.ts')
    src_shared = str(platform_dir / 'hooks' / 'opencode-shared.mjs')
    dst_plugin = os.path.join(opencode_plugins_dir, 'pet-plugin.ts')
    dst_shared = os.path.join(opencode_plugins_dir, 'opencode-shared.mjs')
    companion = os.path.join(opencode_plugins_dir, '.kotori-pet-config-dir')

    if not os.path.exists(src_plugin):
        print(f'OpenCode plugin source not found, skipped: {src_plugin}')
        return None
    if not os.path.exists(src_shared):
        print(f'OpenCode shared module not found, skipped: {src_shared}')
        return None

    print('Deploying OpenCode plugin...')
    os.makedirs(opencode_plugins_dir, exist_ok=True)
    shutil.copy2(src_plugin, dst_plugin)
    shutil.copy2(src_shared, dst_shared)

    with open(companion, 'w', encoding='utf-8') as file_obj:
        file_obj.write(str(platform_dir.resolve()))

    print(f'  Plugin deployed to: {dst_plugin}')
    print(f'  Shared module deployed to: {dst_shared}')
    print(f'  Companion config written to: {companion}')
    return dst_plugin


def build_python_hook_command(python_command, script_path):
    """Build a Windows hook command: `<python> <script.py>` with both parts
    quoted and the script path forward-slashed so sh (Git Bash, used by
    Claude Code/Codex to run hooks) doesn't mangle backslashes.

    python_command is either an absolute interpreter path (sys.executable,
    possibly containing spaces like 'C:/Program Files/.../python.exe') or a
    bare multi-token command ('py -3'). A path with spaces must stay a single
    quoted token — splitting on whitespace would shatter it. We distinguish by
    existence: an existing filesystem path is quoted whole; anything else
    (e.g. 'py -3') is split into tokens and each token quoted.
    """
    if os.path.exists(python_command):
        python_part = quote_command_part(to_forward_slash(python_command))
    else:
        python_part = build_command(split_command(python_command))
    script_part = quote_command_part(to_forward_slash(script_path))
    return f'{python_part} {script_part}'


def build_targets(platform_dir, config):
    hooks_config = config.get('hooks', {})
    hook_dir = str(platform_dir / 'hooks')
    hook_script = os.path.join(hook_dir, 'pet-hook.sh')
    python_command = detect_python_command(hooks_config.get('python_command'))

    claude_script = platform_dir / 'hooks' / 'scripts' / 'claude_hook.py'
    codex_script = platform_dir / 'hooks' / 'scripts' / 'codex_hook.py'

    if (is_windows() or is_wsl()) and python_command:
        claude_hook = build_python_hook_command(python_command, claude_script)
        codex_hook = build_python_hook_command(python_command, codex_script)
    else:
        claude_hook = f'{hook_script} claude-code'
        codex_hook = f'{hook_script} codex'

    claude_settings = config_path_or_default(
        hooks_config.get('claude_code_settings'),
        default_claude_settings(),
    )
    codex_settings = config_path_or_default(
        hooks_config.get('codex_hooks'),
        default_codex_hooks(),
    )

    targets = [
        HookTarget('Claude Code', claude_settings, claude_hook, CLAUDE_EVENTS, ['claude', 'claude-code']),
        HookTarget(
            'Codex',
            codex_settings,
            codex_hook,
            CODEX_EVENTS,
            ['codex'],
            command_windows=(
                build_python_hook_command(python_command, codex_script)
                if is_windows() and python_command else None
            ),
        ),
    ]
    return targets, hooks_config, python_command


def main():
    platform_dir = Path(sys.argv[1]).resolve()
    config, config_source = load_app_config(platform_dir)
    targets, hooks_config, python_command = build_targets(platform_dir, config)

    print(f'Using config: {config_source}')

    configured = []
    skipped = []

    if is_windows() and not python_command:
        print('[setup-hooks] Python 3 not found; Claude/Codex hooks will be skipped.')
        print('              To pin a specific interpreter, set "python_command" under "hooks"')
        print('              in config.json (e.g. "python", "py -3", or an absolute path).')

    for target in targets:
        if not is_tool_available(target.executable_names):
            skipped.append((target.name, 'command not found'))
            print(f'Skipping {target.name}: command not found')
            continue
        if is_windows() and not python_command:
            skipped.append((target.name, 'Python 3 not found'))
            print(f'Skipping {target.name}: Python 3 not found')
            continue
        configured.append(setup_platform(target))

    codex_target = next((target for target in targets if target.name == 'Codex'), None)
    if codex_target and any(name == 'Codex' for name, _ in configured):
        enable_codex_pet_hooks(codex_target.settings_path, codex_target.command, CODEX_EVENTS)
        warn_untrusted_codex_hooks(codex_target.settings_path, codex_target.command, CODEX_EVENTS)

    if should_setup_opencode() and is_tool_available(['opencode']):
        deployed = setup_opencode(platform_dir, hooks_config)
        if deployed:
            configured.append(('OpenCode', deployed))
    elif should_setup_opencode():
        skipped.append(('OpenCode', 'command not found'))
        print('Skipping OpenCode: command not found')

    print()
    print('Hook configuration complete.')
    if configured:
        print('Configured:')
        for name, path in configured:
            print(f'  - {name}: {path}')
    if skipped:
        print('Skipped:')
        for name, reason in skipped:
            print(f'  - {name}: {reason}')
        print('Install skipped tools later, then rerun setup-hooks.')
    if any(name == 'Codex' for name, _ in configured):
        print('If Codex does not react yet, run /hooks in Codex and Trust/Enable the pet hook once.')
    print('New hooks usually take effect in new sessions or after restarting the corresponding CLI.')


if __name__ == '__main__':
    main()
