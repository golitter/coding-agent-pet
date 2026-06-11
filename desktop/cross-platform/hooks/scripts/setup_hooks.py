"""KotoriPet Hook 配置脚本。

配置 Claude Code / Codex 的 hook 条目，部署 OpenCode 插件。
由 setup-hooks.sh 调用。
"""

import json
import os
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
    ]

    # ── Claude Code & Codex ──
    setup_platform(claude_settings, claude_hook, CLAUDE_EVENTS, 'Claude Code', OLD_PATHS)
    setup_platform(codex_settings, codex_hook, CODEX_EVENTS, 'Codex', OLD_PATHS)

    # ── OpenCode ──
    setup_opencode(platform_dir, hooks_config)

    print()
    print('✅ Hook 配置完成！')
    print(f'   Claude Code: {claude_settings}')
    print(f'   Codex:       {codex_settings}')


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
