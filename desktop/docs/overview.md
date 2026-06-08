# Kotori 虚拟桌面宠物 — 跨平台实现概述

## 是什么

Kotori 虚拟桌面宠物将像素风南小鸟以浮窗形式显示在桌面上，根据 Claude Code 和 OpenAI Codex 的生命周期事件切换动画和对话气泡，支持多会话并行。

基于 [Tauri v2](https://v2.tauri.app/) 构建，后端使用 Rust，前端使用 HTML/CSS/JS，具备跨平台潜力（macOS / Windows / Linux）。

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
            │  Unix Socket │  文件监控   │
            ▼─────────────┴────────────▼
              KotoriPet (Tauri)
              ┌──────────────────────────────┐
              │  Rust 后端                    │
              │  ├── session.rs — 多会话聚合   │
              │  ├── watcher.rs — 状态监听     │
              │  └── config.rs — 配置加载      │
              ├──────────────────────────────┤
              │  HTML/CSS/JS 前端             │
              │  ├── main.js — 入口 + 交互    │
              │  ├── animator.js — 动画引擎    │
              │  ├── bubble.js — 对话气泡      │
              │  └── style.css — 样式         │
              └──────────────────────────────┘
              交互: 点击跳跃 | 拖动移动 | 右键菜单
```

## 目录结构

```
desktop/
├── docs/                              # 文档
│   ├── overview.md                    #   本文件 — 概述
│   ├── hooks.md                       #   Hook 脚本详解
│   ├── renderer.md                    #   Tauri 渲染器详解
│   └── spritesheet.md                 #   精灵图规格
├── cross-platform/                    # 主实现 (Tauri)
│   ├── config.example.json            # 配置模板（提交到 git）
│   ├── config.json                    # 用户配置（自动生成，.gitignore）
│   ├── setup.sh                       # 一键安装/更新脚本
│   ├── setup-hooks.sh                 # Hook 配置脚本
│   ├── build-and-run.sh               # 编译并启动脚本
│   ├── package.json                   # Node.js 前端依赖
│   ├── hooks/                         # Hook 脚本
│   │   ├── pet-claude-hook.sh         #   Claude Code 入口 (shell wrapper)
│   │   ├── pet-codex-hook.sh          #   Codex 入口 (shell wrapper)
│   │   └── scripts/                   #   Python 实现
│   │       ├── common.py              #     共享逻辑
│   │       ├── claude_hook.py         #     Claude Code 事件处理
│   │       └── codex_hook.py          #     Codex 事件处理
│   ├── src/                           # 前端源码 (HTML/CSS/JS)
│   │   ├── index.html                 #   主页面
│   │   ├── main.js                    #   入口, 窗口设置, 交互绑定
│   │   ├── animator.js                #   精灵动画引擎
│   │   ├── bubble.js                  #   对话气泡
│   │   └── style.css                  #   全局样式
│   ├── src-tauri/                     # Rust 后端 (Tauri)
│   │   ├── Cargo.toml                 #   Rust 依赖
│   │   ├── tauri.conf.json            #   Tauri 窗口/安全配置
│   │   ├── build.rs                   #   Tauri 构建脚本
│   │   ├── capabilities/default.json  #   权限声明
│   │   └── src/
│   │       ├── main.rs                #   入口
│   │       ├── lib.rs                 #   应用初始化, 组件串联
│   │       ├── config.rs              #   配置加载 + 路径自动检测
│   │       ├── commands.rs            #   Tauri commands (前端调用)
│   │       ├── session.rs             #   多会话聚合
│   │       └── watcher.rs             #   双通道状态监听
│   └── runtime/
│       └── sessions/                  # 运行时会话状态文件
├── mac/                               # ⚠️ 已弃用 — 旧版 macOS Swift 实现
└── kotori-minami/                     # 宠物资源 (只读)
    ├── frames/                        #   55 帧 PNG 动画
    └── final/spritesheet.webp         #   精灵图
```

## 快速开始

```bash
git clone <repo> ~/pet
cd ~/pet
./desktop/cross-platform/setup.sh
```

`setup.sh` 自动完成：安装前端依赖 → 生成配置 → 配置 hooks → 编译 → 启动。

## 配置

所有可配置项在 `desktop/cross-platform/config.json`，首次运行自动从 `config.example.json` 复制。

路径设为 `null` 时自动检测，无需手动填写。详见 [config.example.json](../cross-platform/config.example.json)。

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
| `setup.sh` | 全流程：安装依赖 → 生成配置 → 配置 hooks → 编译 → 启动 |
| `setup-hooks.sh` | 单独配置 hooks（Claude Code + Codex）|
| `build-and-run.sh` | 单独编译并重启渲染器 |

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Rust + Tauri v2 | 窗口管理、会话聚合、文件/Socket 监听 |
| 前端 | HTML + CSS + JS | 精灵动画、对话气泡、交互 |
| 通信 | Tauri Event + IPC | Rust → JS 状态推送 |
| 构建 | npm + Cargo | 前端依赖 + Rust 编译 |
