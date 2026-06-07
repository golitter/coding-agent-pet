# Kotori 虚拟桌面宠物 — macOS 实现概述

## 是什么

Kotori 虚拟桌面宠物将像素风南小鸟以浮窗形式显示在 macOS 桌面上，根据 Claude Code 和 OpenAI Codex 的生命周期事件切换动画和对话气泡，支持多会话并行。

## 系统架构

```
┌───────────────────────────────────────────────────────────────┐
│                        AI 编码工具                              │
│  ┌─────────────────┐              ┌─────────────────┐         │
│  │   Claude Code    │              │     Codex        │         │
│  └────────┬────────┘              └────────┬────────┘         │
└───────────┼─────────────────────────────────┼─────────────────┘
            │ stdin JSON                      │ stdin JSON
            ▼                                 ▼
   pet-claude-hook.sh                pet-codex-hook.sh
            │                                 │
            └────────────┬────────────────────┘
                         ▼
              config.json (统一配置)
                         │
              runtime/sessions/{session_id}.json
                         │
            ┌────────────┼────────────┐
            │  Socket     │  文件监控   │
            ▼─────────────┴────────────▼
              KotoriPet 渲染器 (Swift)
              ┌───────────────────────┐
              │   对话气泡 ( DialogueBubble )   │
              │   宠物动画 ( NSImageView )       │
              └───────────────────────┘
              交互: 拖动移动 | 右键菜单
```

## 目录结构

```
desktop/
├── docs/                              # 文档
│   ├── overview.md                    #   本文件 — 概述
│   ├── hooks.md                       #   Hook 脚本详解
│   ├── renderer.md                    #   Swift 渲染器详解
│   └── spritesheet.md                 #   精灵图规格
├── mac/
│   ├── config.example.json            # 配置模板（提交到 git）
│   ├── config.json                    # 用户配置（自动生成，.gitignore）
│   ├── setup.sh                       # 一键安装/更新脚本
│   ├── setup-hooks.sh                 # Hook 配置脚本
│   ├── build-and-run.sh               # 编译并启动脚本
│   ├── hooks/                         # Hook 脚本
│   │   ├── pet-claude-hook.sh         #   Claude Code 事件处理
│   │   └── pet-codex-hook.sh          #   Codex 事件处理
│   ├── renderer/                      # Swift 渲染器
│   │   ├── Package.swift
│   │   └── Sources/KotoriPet/
│   │       ├── Config.swift           #   配置加载 + 路径自动检测
│   │       ├── main.swift             #   入口, 组件串联
│   │       ├── PetWindow.swift        #   浮窗窗口 + 交互
│   │       ├── DialogueBubble.swift   #   对话气泡
│   │       ├── FrameCache.swift       #   帧缓存加载
│   │       ├── SpriteAnimator.swift   #   动画循环引擎
│   │       ├── SessionManager.swift   #   多会话聚合
│   │       └── StateWatcher.swift     #   状态监听
│   └── runtime/
│       └── sessions/                  # 运行时会话状态文件
└── kotori-minami/                     # 宠物资源 (只读)
    ├── frames/                        #   55 帧 PNG 动画
    └── final/spritesheet.webp         #   精灵图
```

## 快速开始

```bash
git clone <repo> ~/pet
cd ~/pet
./desktop/mac/setup.sh
```

`setup.sh` 自动完成：生成配置 → 配置 hooks → 编译 → 启动。

## 配置

所有可配置项在 `desktop/mac/config.json`，首次运行自动从 `config.example.json` 复制。

路径设为 `null` 时自动检测，无需手动填写。详见 [config.example.json](mac/config.example.json)。

主要配置项：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `pet_id` | 宠物 ID | `kotori-minami` |
| `pet_base_dir` | 项目根目录 | `null`（自动检测） |
| `socket_path` | Unix socket 路径 | `/tmp/kotori-pet.sock` |
| `renderer.scale` | 缩放因子 | `0.6` |
| `renderer.fps` | 帧率 | `10` |
| `state_map` | 事件→动画+台词映射 | 见配置文件 |
| `menu.items` | 右键菜单项 | Codex, VS Code, 关闭宠物 |

## 脚本说明

| 脚本 | 用途 |
|---|---|
| `setup.sh` | 全流程：生成配置 → 配置 hooks → 编译 → 启动 |
| `setup-hooks.sh` | 单独配置 hooks（Claude Code + Codex）|
| `build-and-run.sh` | 单独编译并重启渲染器 |
