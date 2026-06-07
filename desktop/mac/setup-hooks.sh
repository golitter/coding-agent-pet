#!/bin/bash
# KotoriPet Hook 配置脚本
# 自动将 pet hook 添加到 Claude Code 和 Codex 的 settings 中
set -euo pipefail

MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$MAC_DIR/config.json"
EXAMPLE="$MAC_DIR/config.example.json"

# 用 python3 从 config 读取所有配置，避免硬编码
/usr/bin/python3 -c "
import json, os
from pathlib import Path

mac_dir = Path('$MAC_DIR')
config_path = str(mac_dir / 'config.json')
example_path = str(mac_dir / 'config.example.json')

if os.path.exists(config_path):
    p = config_path
elif os.path.exists(example_path):
    p = example_path
else:
    print('[setup-hooks] No config found', flush=True)
    exit(1)

with open(p) as f:
    config = json.load(f)

# ── Resolve paths ──
repo_root = mac_dir.parent.parent  # desktop/mac → repo

def resolve(val, *parts):
    if val is not None and isinstance(val, str) and val.strip():
        p = os.path.expanduser(val)
        if os.path.isabs(p):
            return p
        return str(repo_root / p)
    return str(repo_root.joinpath(*parts))

pet_base_dir = resolve(config.get('pet_base_dir'))
hook_dir     = str(mac_dir / 'hooks')
claude_hook  = os.path.join(hook_dir, 'pet-claude-hook.sh')
codex_hook   = os.path.join(hook_dir, 'pet-codex-hook.sh')

hooks_config = config.get('hooks', {})
claude_settings = os.path.expanduser(hooks_config.get('claude_code_settings', '~/.claude/settings.json'))
codex_settings  = os.path.expanduser(hooks_config.get('codex_hooks', '~/.Codex/hooks.json'))

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
]

def setup_platform(settings_path, hook_cmd, events, platform_name):
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
                    for old in OLD_PATHS:
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

    with open(settings_path, 'w') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)

    print(f'  ✓ 已配置 {len(events)} 个 {platform_name} hook 事件')

# ─── Claude Code ───
setup_platform(claude_settings, claude_hook, CLAUDE_EVENTS, 'Claude Code')

# ─── Codex ───
setup_platform(codex_settings, codex_hook, CODEX_EVENTS, 'Codex')

print()
print('✅ Hook 配置完成！')
print(f'   Claude Code: {claude_settings}')
print(f'   Codex:       {codex_settings}')
"
