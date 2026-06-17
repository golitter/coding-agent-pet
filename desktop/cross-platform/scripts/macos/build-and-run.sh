#!/bin/bash
# KotoriPet (Tauri) 编译并启动脚本
set -euo pipefail

# 项目根目录（cross-platform，src-tauri / runtime 所在地）
PLATFORM_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TAURI_DIR="$PLATFORM_DIR/src-tauri"
BINARY="$TAURI_DIR/target/debug/kotori-pet"

echo "🔨 编译 KotoriPet (Tauri)..."
(cd "$PLATFORM_DIR" && npx tauri build --debug 2>&1)

echo "🧹 清除签名限制..."
if [[ "$(uname)" == "Darwin" ]]; then
    xattr -cr "$BINARY" 2>/dev/null || true
fi

echo "🛑 停止旧进程..."
pkill -x "kotori-pet" 2>/dev/null || true
sleep 1

# 确保 sessions 目录存在
mkdir -p "$PLATFORM_DIR/runtime/sessions"

echo "🚀 启动新版本..."
nohup "$BINARY" </dev/null > /tmp/kotori-pet-tauri.log 2>&1 &
disown || true

sleep 2

stable_pid=""
for _ in {1..10}; do
    stable_pid="$(pgrep -x "kotori-pet" | tail -n 1 || true)"
    if [[ -n "$stable_pid" ]]; then
        sleep 1
        if kill -0 "$stable_pid" 2>/dev/null; then
            break
        fi
    fi
    stable_pid=""
    sleep 1
done

# 验证
if [[ -n "$stable_pid" ]] && kill -0 "$stable_pid" 2>/dev/null; then
    echo "✅ KotoriPet (Tauri) 已启动 (PID: $stable_pid)"
else
    echo "❌ 启动失败，查看日志: cat /tmp/kotori-pet-tauri.log"
    exit 1
fi
