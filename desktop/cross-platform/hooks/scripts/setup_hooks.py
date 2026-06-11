"""KotoriPet Hook 配置脚本。

配置 Claude Code / Codex 的 hook 条目，部署 OpenCode 插件。
由 setup-hooks.sh 调用。
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path


def main():
    platform_dir = Path(sys.argv[1])
    config_path = str(platform_dir / 'config.json')
    example_path = str(platform_dir / 'config.example.json')

    if os.path.exists(config_path):
        p = config_path
    elif os.path.exists(example_path):
        p = example_path
    else:
        print('[setup-hooks] No config found', flush=True)
        sys.exit(1)

    with open(p) as f:
        config = json.load(f)

    # ── Resolve paths ──
    hook_dir    = str(platform_dir / 'hooks')
    hook_script = os.path.join(hook_dir, 'pet-hook.sh')
    claude_hook = f'{hook_script} claude-code'
    codex_hook  = f'{hook_script} codex'

    hooks_config   = config.get('hooks', {})
    claude_settings = os.path.expanduser(hooks_config.get('claude_code_settings', '~/.claude/settings.json'))
    codex_settings  = os.path.expanduser(hooks_config.get('codex_hooks', '~/.codex/hooks.json'))

    # ── Event lists ──
    CLAUDE_EVENTS = [
        'Notification', 'PermissionRequest', 'PostToolUse', 'PreCompact',
        'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure',
        'SubagentStop', 'UserPromptSubmit',
    ]

    CODEX_EVENTS = [
        'Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse',
        'SessionStart', 'Stop', 'StopFailure', 'SubagentStop', 'UserPromptSubmit',
    ]

    # Old paths to clean up (from previous versions)
    OLD_PATHS = [
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

    # ── Claude Code & Codex ──
    setup_platform(claude_settings, claude_hook, CLAUDE_EVENTS, 'Claude Code', OLD_PATHS)
    setup_platform(codex_settings, codex_hook, CODEX_EVENTS, 'Codex', OLD_PATHS)
    enable_codex_pet_hooks(codex_settings, codex_hook, CODEX_EVENTS)
    warn_untrusted_codex_hooks(codex_settings, codex_hook, CODEX_EVENTS)

    # ── OpenCode ──
    setup_opencode(platform_dir, hooks_config)

    print()
    print('✅ Hook 配置完成！')
    print(f'   Claude Code: {claude_settings}')
    print(f'   Codex:       {codex_settings}')
    print('   Codex 提醒: 如宠物仍无反应，请在 Codex 中运行 /hooks 并 Trust/Enable pet hook。')
    print('   Codex 提醒: hooks 配置通常在新会话/重启后加载；当前已打开的会话可能不会立即生效。')


def setup_platform(settings_path, hook_cmd, events, platform_name, old_paths):
    """Register pet hook entries in Claude Code / Codex settings."""
    print(f'📋 配置 {platform_name} hooks...')

    try:
        with open(settings_path, 'r') as f:
            settings = json.load(f)
    except FileNotFoundError:
        settings = {}

    if 'hooks' not in settings:
        settings['hooks'] = {}

    # Remove old pet hook entries
    for event_name in list(settings['hooks'].keys()):
        filtered = []
        for entry in settings['hooks'][event_name]:
            keep = True
            if 'hooks' in entry:
                for h in entry['hooks']:
                    cmd = h.get('command', '')
                    for old in old_paths:
                        if old in cmd:
                            keep = False
                            break
                    # Also remove current path to avoid duplicates
                    if hook_cmd in cmd:
                        keep = False
            if keep:
                filtered.append(entry)
        settings['hooks'][event_name] = filtered

    # Add new pet hook
    for event_name in events:
        if event_name not in settings['hooks']:
            settings['hooks'][event_name] = []
        settings['hooks'][event_name].append({
            'hooks': [{
                'command': hook_cmd,
                'type': 'command'
            }]
        })

    # Atomic write: write to tmp file first, then rename
    tmp_path = settings_path + '.tmp'
    try:
        with open(tmp_path, 'w') as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, settings_path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise

    print(f'  ✓ 已配置 {len(events)} 个 {platform_name} hook 事件')


def normalize_codex_event(event_name):
    """Codex stores hook trust state with snake_case event ids."""
    return re.sub(r'(?<!^)([A-Z])', r'_\1', event_name).lower()


def codex_hooks_state_path(settings_path):
    """Return the path shape Codex uses in [hooks.state] keys."""
    return str(Path(settings_path).expanduser()).replace('/.Codex/', '/.codex/')


def load_codex_pet_hook_positions(settings_path, hook_cmd, events):
    """Find matcher/hook indexes for this exact pet hook command."""
    try:
        settings = json.loads(Path(settings_path).read_text())
    except (OSError, json.JSONDecodeError):
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

    tmp_path = str(config_toml) + '.tmp'
    try:
        with open(tmp_path, 'w') as f:
            f.write(text)
        os.replace(tmp_path, config_toml)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise

    print(f'  ✓ 已自动启用 {enabled_count} 个 Codex pet hook 状态')


def warn_untrusted_codex_hooks(settings_path, hook_cmd, events):
    """Best-effort diagnostic for Codex's review/trust gate."""
    config_toml = str(Path(settings_path).with_name('config.toml'))
    try:
        text = Path(config_toml).read_text()
    except OSError:
        print('  ⚠ Codex config.toml 不存在；首次启动 Codex 后请运行 /hooks 信任宠物 hook')
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
        print('  ⚠ Codex hook 已写入，但以下事件尚未在 /hooks 中启用/信任:')
        print('    ' + ', '.join(missing))
        print('    请在 Codex 输入 /hooks，逐项 Trust/Enable 这个命令:')
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
        print('  ⚠ OpenCode 插件源码不存在，跳过:', src_plugin)
        return

    print('📋 配置 OpenCode 插件...')
    os.makedirs(opencode_plugins_dir, exist_ok=True)

    # 复制插件（源文件名 opencode-plugin.ts → 部署名 pet-plugin.ts）
    shutil.copy2(src_plugin, dst_plugin)

    # 写入同伴文件：platform dir 绝对路径
    with open(companion, 'w') as f:
        f.write(str(platform_dir))

    print(f'  ✓ 插件已部署: {dst_plugin}')
    print(f'  ✓ 配置文件:   {companion}')


if __name__ == '__main__':
    main()
