#!/bin/bash
# KotoriPet 全流程一键脚本
# 配置 hooks → 编译渲染器 → 启动宠物
set -euo pipefail

MAC_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$MAC_DIR/config.json"
EXAMPLE="$MAC_DIR/config.example.json"

echo "═══════════════════════════════════════"
echo "  🐦 Kotori Pet — 一键安装/更新"
echo "═══════════════════════════════════════"
echo ""

# Step 0: Ensure config.json exists
if [ ! -f "$CONFIG" ]; then
    if [ -f "$EXAMPLE" ]; then
        cp "$EXAMPLE" "$CONFIG"
        echo "📝 已从 config.example.json 创建 config.json"
        echo "   如需自定义，请编辑: $CONFIG"
        echo ""
    else
        echo "❌ 找不到 config.example.json"
        exit 1
    fi
else
    echo "📝 使用已有 config.json"
    echo ""
fi

# Step 1: 配置 hooks
echo "📌 Step 1/3: 配置 Hook 脚本..."
"$MAC_DIR/setup-hooks.sh"

# Step 2: 编译 + 启动
echo ""
echo "📌 Step 2/3: 编译并启动渲染器..."
"$MAC_DIR/build-and-run.sh"

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ 全部完成！宠物已出现在桌面右下角"
echo "     拖动移动 | 右键打开菜单"
echo ""
echo "  ⚙️  自定义配置: $CONFIG"
echo "═══════════════════════════════════════"
