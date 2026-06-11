#!/bin/bash
# KotoriPet (Tauri) Hook 配置脚本
# 自动将 pet hook 添加到 Claude Code 和 Codex 的 settings 中，部署 OpenCode 插件
set -euo pipefail

PLATFORM_DIR="$(cd "$(dirname "$0")" && pwd)"

/usr/bin/python3 "$PLATFORM_DIR/hooks/scripts/setup_hooks.py" "$PLATFORM_DIR"
