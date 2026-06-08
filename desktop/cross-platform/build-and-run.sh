#!/bin/bash
# KotoriPet (Tauri) 编译并启动脚本
set -euo pipefail

PLATFORM_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$PLATFORM_DIR/src-tauri"

echo "🔨 编译 KotoriPet (Tauri)..."
(cd "$PLATFORM_DIR" && npx tauri build --debug 2>&1)

BINARY="$TAURI_DIR/target/debug/kotori-pet"

echo "🧹 清除签名限制..."
if [[ "$(uname)" == "Darwin" ]]; then
    xattr -cr "$BINARY" 2>/dev/null || true
fi

echo "🛑 停止旧进程..."
pkill -f "kotori-pet" 2>/dev/null || true
sleep 1

# 确保 sessions 目录存在
mkdir -p "$PLATFORM_DIR/runtime/sessions"

echo "🚀 启动新版本..."
nohup "$BINARY" > /tmp/kotori-pet-tauri.log 2>&1 &
sleep 2

# 验证
if pgrep -f "kotori-pet" > /dev/null; then
    PID=$(pgrep -f "kotori-pet")
    echo "✅ KotoriPet (Tauri) 已启动 (PID: $PID)"
else
    echo "❌ 启动失败，查看日志: cat /tmp/kotori-pet-tauri.log"
    exit 1
fi
