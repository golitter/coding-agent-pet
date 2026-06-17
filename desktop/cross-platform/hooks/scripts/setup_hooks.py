"""Configure pet hooks for Claude Code, Codex, and OpenCode."""

import json
import os
import re
import shutil
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


def detect_python_command():
    """Return a bare python command name that exists on PATH.

    We deliberately keep the bare name (e.g. 'python') rather than the
    resolved absolute path: Claude Code/Codex execute hooks via sh, and a
    bare command lets the hook survive python upgrades/reinstalls without
    rewriting settings.json. The hook scripts are stdlib-only, so any
    python on PATH works. Windows order prefers 'python' (some installs
    lack a 'python3' alias).
    """
    candidates = ('python', 'py -3', 'python3') if is_windows() else ('python3', 'python')
    for candidate in candidates:
        parts = split_command(candidate)
        if parts and shutil.which(parts[0]):
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
    dst_plugin = os.path.join(opencode_plugins_dir, 'pet-plugin.ts')
    companion = os.path.join(opencode_plugins_dir, '.kotori-pet-config-dir')

    if not os.path.exists(src_plugin):
        print(f'OpenCode plugin source not found, skipped: {src_plugin}')
        return None

    print('Deploying OpenCode plugin...')
    os.makedirs(opencode_plugins_dir, exist_ok=True)
    shutil.copy2(src_plugin, dst_plugin)

    with open(companion, 'w', encoding='utf-8') as file_obj:
        file_obj.write(str(platform_dir.resolve()))

    print(f'  Plugin deployed to: {dst_plugin}')
    print(f'  Companion config written to: {companion}')
    return dst_plugin


def build_targets(platform_dir, config):
    hooks_config = config.get('hooks', {})
    hook_dir = str(platform_dir / 'hooks')
    hook_script = os.path.join(hook_dir, 'pet-hook.sh')
    python_command = detect_python_command()

    claude_script = platform_dir / 'hooks' / 'scripts' / 'claude_hook.py'
    codex_script = platform_dir / 'hooks' / 'scripts' / 'codex_hook.py'

    if is_windows() and python_command:
        # Forward slashes: sh treats backslashes as escapes.
        claude_hook = f'{python_command} {quote_command_part(str(claude_script).replace(chr(92), "/"))}'
        codex_hook = f'{python_command} {quote_command_part(str(codex_script).replace(chr(92), "/"))}'
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
                f'{python_command} {quote_command_part(str(codex_script).replace(chr(92), "/"))}'
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

    if is_tool_available(['opencode']):
        deployed = setup_opencode(platform_dir, hooks_config)
        if deployed:
            configured.append(('OpenCode', deployed))
    else:
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
