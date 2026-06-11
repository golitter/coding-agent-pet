"""Configure pet hooks for Claude Code, Codex, and OpenCode."""

import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

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
]


@dataclass(frozen=True)
class HookTarget:
    name: str
    settings_path: str
    command: str
    events: list[str]


def load_json(path, default=None):
    try:
        with open(path, 'r') as file_obj:
            return json.load(file_obj)
    except FileNotFoundError:
        return {} if default is None else default


def atomic_write(path, content):
    tmp_path = f'{path}.tmp'
    try:
        with open(tmp_path, 'w') as file_obj:
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


def is_managed_pet_command(command, expected_command):
    fragments = LEGACY_HOOK_FRAGMENTS + [expected_command]
    return any(fragment in command for fragment in fragments)


def filter_out_pet_hooks(entries, expected_command):
    cleaned_entries = []
    for entry in entries:
        hooks = entry.get('hooks', [])
        managed_hook_found = any(
            is_managed_pet_command(hook.get('command', ''), expected_command)
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
        hooks_section.setdefault(event_name, []).append({
            'hooks': [{
                'command': target.command,
                'type': 'command',
            }]
        })


def setup_platform(target):
    """Register the pet hook in Claude Code or Codex settings."""
    print(f'更新 {target.name} hooks...')
    settings = load_json(target.settings_path, default={})
    install_event_hooks(settings, target)
    atomic_write_json(target.settings_path, settings)
    print(f'  已写入 {len(target.events)} 个事件到 {target.settings_path}')


def main():
    platform_dir = Path(sys.argv[1])
    config, config_source = load_app_config(platform_dir)

    hook_dir = str(platform_dir / 'hooks')
    hook_script = os.path.join(hook_dir, 'pet-hook.sh')
    claude_hook = f'{hook_script} claude-code'
    codex_hook = f'{hook_script} codex'

    hooks_config = config.get('hooks', {})
    claude_settings = os.path.expanduser(hooks_config.get('claude_code_settings', '~/.claude/settings.json'))
    codex_settings = os.path.expanduser(hooks_config.get('codex_hooks', '~/.codex/hooks.json'))

    print(f'使用配置文件: {config_source}')

    targets = [
        HookTarget('Claude Code', claude_settings, claude_hook, CLAUDE_EVENTS),
        HookTarget('Codex', codex_settings, codex_hook, CODEX_EVENTS),
    ]

    for target in targets:
        setup_platform(target)

    enable_codex_pet_hooks(codex_settings, codex_hook, CODEX_EVENTS)
    warn_untrusted_codex_hooks(codex_settings, codex_hook, CODEX_EVENTS)
    setup_opencode(platform_dir, hooks_config)

    print()
    print('Hook 配置完成。')
    print(f'  Claude Code 配置: {claude_settings}')
    print(f'  Codex 配置:       {codex_settings}')
    print('  如果 Codex 里的宠物还没反应，请在 Codex 中运行 /hooks，把 pet hook Trust/Enable 一次。')
    print('  新写入的 hooks 往往要在新会话或重启后才会稳定生效。')


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
    """Auto-enable already trusted Codex pet hook state entries.

    This does not invent trust hashes. It only adds `enabled = true` to the
    exact pet hook sections that Codex has already materialized in config.toml.
    """
    config_toml = Path(settings_path).with_name('config.toml')
    try:
        text = config_toml.read_text()
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

    atomic_write(config_toml, text)
    print(f'  已自动启用 {enabled_count} 个 Codex hook 状态')


def warn_untrusted_codex_hooks(settings_path, hook_cmd, events):
    """Best-effort diagnostic for Codex's review/trust gate."""
    config_toml = str(Path(settings_path).with_name('config.toml'))
    try:
        text = Path(config_toml).read_text()
    except OSError:
        print('  Codex 的 config.toml 还不存在；先启动一次 Codex，再到 /hooks 里信任 pet hook 即可。')
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
        print('  Codex hook 已写入，但下面这些事件还没有在 /hooks 中启用或信任:')
        print('    ' + ', '.join(missing))
        print('    请在 Codex 输入 /hooks，逐项 Trust/Enable 这条命令:')
        print(f'    {hook_cmd}')


def setup_opencode(platform_dir, hooks_config):
    """Deploy OpenCode plugin + companion config file."""
    opencode_plugins_dir = os.path.expanduser(
        hooks_config.get('opencode_plugins_dir', '~/.config/opencode/plugins')
    )
    src_plugin = str(platform_dir / 'hooks' / 'opencode-plugin.ts')
    dst_plugin = os.path.join(opencode_plugins_dir, 'pet-plugin.ts')
    companion  = os.path.join(opencode_plugins_dir, '.kotori-pet-config-dir')

    if not os.path.exists(src_plugin):
        print(f'OpenCode 插件源码不存在，已跳过: {src_plugin}')
        return

    print('部署 OpenCode 插件...')
    os.makedirs(opencode_plugins_dir, exist_ok=True)

    # 复制插件（源文件名 opencode-plugin.ts → 部署名 pet-plugin.ts）
    shutil.copy2(src_plugin, dst_plugin)

    # 写入同伴文件：platform dir 绝对路径
    with open(companion, 'w') as f:
        f.write(str(platform_dir))

    print(f'  插件已部署到: {dst_plugin}')
    print(f'  配置文件已写入: {companion}')


if __name__ == '__main__':
    main()
