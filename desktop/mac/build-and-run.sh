#!/bin/bash
# KotoriPet 编译并启动脚本
set -euo pipefail

MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$MAC_DIR/config.json"
EXAMPLE="$MAC_DIR/config.example.json"
RENDERER_DIR="$MAC_DIR/renderer"

# 用 python3 从 config 读取或自动检测路径
eval "$(python3 -c "
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
    p = config_path

try:
    with open(p) as f:
        c = json.load(f)
except:
    c = {}

base = c.get('pet_base_dir') or str(mac_dir.parent.parent)
base = os.path.expanduser(base) if base else str(mac_dir.parent.parent)
sessions = c.get('sessions_dir') or os.path.join(base, 'desktop/mac/runtime/sessions')

print(f'RENDERER_DIR=\"$MAC_DIR/renderer\"')
print(f'SESSIONS_DIR=\"{sessions}\"')
")"

BINARY="$RENDERER_DIR/.build/release/KotoriPet"

echo "🔨 编译 KotoriPet..."
(cd "$RENDERER_DIR" && swift build -c release 2>&1)

echo "🧹 清除签名限制..."
xattr -cr "$BINARY" 2>/dev/null || true

echo "🛑 停止旧进程..."
pkill -f "KotoriPet" 2>/dev/null || true
sleep 1

# 确保 sessions 目录存在
mkdir -p "$SESSIONS_DIR"

echo "🚀 启动新版本..."
nohup "$BINARY" > /tmp/kotori-pet.log 2>&1 &
sleep 2

# 验证
if pgrep -f "KotoriPet" > /dev/null; then
    PID=$(pgrep -f "KotoriPet")
    echo "✅ KotoriPet 已启动 (PID: $PID)"
else
    echo "❌ 启动失败，查看日志: cat /tmp/kotori-pet.log"
    exit 1
fi
