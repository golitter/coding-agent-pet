#!/bin/bash
# KotoriPet (Tauri) 全流程一键脚本
# 配置 hooks → 编译渲染器 → 启动宠物
set -euo pipefail

PLATFORM_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$PLATFORM_DIR/config.json"
EXAMPLE="$PLATFORM_DIR/config.example.json"

echo "═══════════════════════════════════════"
echo "  🐦 Kotori Pet (Tauri) — 一键安装/更新"
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

# Step 1: 安装前端依赖
if [ ! -d "$PLATFORM_DIR/node_modules" ]; then
    echo "📌 Step 1/4: 安装前端依赖..."
    (cd "$PLATFORM_DIR" && npm install)
else
    echo "📌 Step 1/4: 前端依赖已安装，跳过"
fi

# Step 2: 配置 hooks
echo ""
echo "📌 Step 2/4: 配置 Hook 脚本..."
"$PLATFORM_DIR/setup-hooks.sh"

# Step 3: 编译 + 启动
echo ""
echo "📌 Step 3/4: 编译并启动渲染器..."
"$PLATFORM_DIR/build-and-run.sh"

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ 全部完成！宠物已出现在桌面右下角"
echo "     点击跳跃 | 拖动移动 | 右键打开菜单"
echo ""
echo "  ⚙️  自定义配置: $CONFIG"
echo "═══════════════════════════════════════"
