# Kotori 虚拟桌面宠物 — 跨平台实现概述

## 是什么

Kotori 虚拟桌面宠物将像素风南小鸟以浮窗形式显示在桌面上，根据 Claude Code、OpenAI Codex 和 OpenCode 的生命周期事件切换动画和对话气泡，支持多会话并行。

基于 [Tauri v2](https://v2.tauri.app/) 构建，后端使用 Rust，前端使用 HTML/CSS/JS，具备跨平台潜力（macOS / Windows / Linux）。

## 系统架构

```
┌───────────────────────────────────────────────────────────────────┐
│                          AI 编码工具                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │   Claude Code    │  │     Codex        │  │    OpenCode      │   │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘   │
└───────────┼───────────────────────┼───────────────────┼───────────┘
            │ stdin JSON            │ stdin JSON        │ 进程内 TS
            ▼                       ▼                   ▼
   pet-hook.sh claude-code   pet-hook.sh codex   opencode-plugin.ts
            │                       │                   │
            └───────────┬───────────┘───────────────────┘
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
              │  ├── aggregator.rs — 多会话聚合   │
              │  ├── watcher.rs — 状态监听     │
              │  └── config.rs — 配置加载      │
              ├──────────────────────────────┤
              │  HTML/CSS/JS 前端             │
              │  ├── main.js — 入口 + 交互    │
              │  ├── animator.js — 动画引擎    │
              │  ├── bubble.js — 对话气泡      │
              │  └── style.css — 样式         │
              └──────────────────────────────┘
              交互: 悬停跳跃 | 三连击清空会话 | 拖动移动 | 右键菜单
```

## 目录结构

```
.
├── assets/
│   └── kotori-minami/                 # 宠物资料包 (只读)
│       ├── frames/                    #   57 帧 PNG 动画 (运行时资源)
│       └── imagegen/                  #   生成流水线工件 (prompts/qa/decoded/...)
└── desktop/
    ├── docs/                          # 文档
    │   ├── overview.md                #   本文件 — 概述
    │   ├── renderer.md                #   Tauri 渲染器详解
    │   ├── spritesheet.md             #   精灵图规格
    │   └── tauri-v2-compliance.md     #   Tauri v2 合规审查
    │   ├── design/                    #   设计文档
    │   │   ├── hooks-refactor.md      #     Hook 重构设计
    │   │   ├── hit-test.md            #     透明像素点击穿透
    │   │   ├── opencode-plugin.md     #     OpenCode 插件设计
    │   │   └── opencode-integration-plan.md  # OpenCode 集成计划
    │   ├── agent-hooks/               #   各平台 Hook 机制详解
    │   │   ├── README.md              #     索引 + 三平台对比
    │   │   ├── events.md              #     事件类型对照表
    │   │   ├── claude-code.md         #     Claude Code Hooks → 宠物渲染
    │   │   ├── codex.md               #     Codex Hooks → 宠物渲染
    │   │   └── opencode.md            #     OpenCode 插件系统参考
    │   └── bugfix/                    #   Bugfix 计划
    │       ├── README.md              #     索引
    │       ├── active-count-undercount.md  # 多会话计数 N-1
    │       ├── idle-blink-too-fast.md #     idle 眨眼太快（引入 frame_timing）
    │       ├── pet-unresponsive-stuck-state.md  # 宠物无响应/卡死
    │       ├── stuck-jumping-after-stop.md  # Stop 后卡 jumping、文件不删
    │       ├── context-menu-lingers-on-mouse-leave.md  # 右键菜单鼠标移出后滞留
    │       └── drag-direction-stuck-or-flicker.md  # 拖动方向卡顿/闪烁
    └── cross-platform/                # 主实现 (Tauri)
        ├── config.example.json        #   配置模板（提交到 git）
        ├── config.json                #   用户配置（自动生成，.gitignore）
        ├── scripts/                   #   平台入口脚本（按 OS 分目录）
        │   ├── macos/                 #     setup.sh / setup-hooks.sh / build-and-run.sh
        │   ├── windows/               #     setup.ps1 / setup-hooks.ps1 / build-and-run.ps1
        │   └── wsl/                   #     setup-hooks.sh（WSL2 hooks/plugins → Windows 渲染器）
        ├── package.json               #   Node.js 前端依赖
        ├── hooks/                     #   Hook 脚本
        │   ├── pet-hook.sh            #     Shell 入口 (claude-code / codex)
        │   ├── opencode-plugin.ts     #     OpenCode 插件（TS，进程内运行）
        │   ├── opencode-shared.mjs    #     OpenCode 共享逻辑（事件映射 / payload / IO）
        │   ├── scripts/               #     Python 实现
        │   │   ├── common.py          #       共享逻辑
        │   │   ├── claude_hook.py     #       Claude Code 事件处理
        │   │   ├── codex_hook.py      #       Codex 事件处理
        │   │   ├── setup_hooks.py     #       Hook 注册逻辑
        │   │   └── test_hooks.py      #       轻量测试（事件映射 / 配置写入）
        │   └── tests/                 #     OpenCode 轻量测试（Node --test）
        ├── src/                       #   前端源码 (HTML/CSS/JS)
        │   ├── index.html             #     主页面
        │   ├── main.js                #     入口, 窗口设置, 交互绑定
        │   ├── animator.js            #     精灵动画引擎
        │   ├── bubble.js              #     对话气泡
        │   └── style.css              #     全局样式
        ├── src-tauri/                 #   Rust 后端 (Tauri)
        │   ├── Cargo.toml             #     Rust 依赖
        │   ├── tauri.conf.json        #     Tauri 窗口/安全配置
        │   ├── build.rs               #     Tauri 构建脚本
        │   ├── capabilities/default.json  # 权限声明
        │   └── src/
        │       ├── main.rs            #       入口
        │       ├── lib.rs             #       应用初始化, 组件串联
        │       ├── config.rs          #       配置加载 + 路径自动检测
        │       ├── commands.rs        #       Tauri commands (前端调用)
        │       ├── aggregator.rs      #       多会话聚合 + 磁盘对账
        │       └── watcher.rs         #       双通道状态监听 (socket 主 + 文件对账)
        └── runtime/
            └── sessions/              #     运行时会话状态文件
```

## 快速开始

```bash
git clone <repo> ~/pet
cd ~/pet/desktop/cross-platform
bash scripts/macos/setup.sh
```

`setup.sh`（macOS）/ `setup.ps1`（Windows）自动完成：安装前端依赖 → 生成配置 → 配置 hooks → 编译 → 启动。
入口脚本按平台分目录：`scripts/macos/*.sh`、`scripts/windows/*.ps1`。

WSL2 场景下，Windows 原生应用负责渲染，agent 在 WSL distro 内运行。进入同一份仓库后执行：

```bash
bash scripts/wsl/setup-hooks.sh
```

该入口只配置 WSL 侧 Claude Code / Codex hooks 和 OpenCode 插件，不安装依赖、不构建、不启动 Tauri；事件默认通过 `tcp://127.0.0.1:17361` 推给 Windows 渲染器。

## 配置

所有可配置项在 `desktop/cross-platform/config.json`，首次运行自动从 `config.example.json` 复制。

路径设为 `null` 时自动检测，无需手动填写。详见 [config.example.json](../cross-platform/config.example.json)。

主要配置项：

| 配置项           | 说明               | 默认值                 |
| ---------------- | ------------------ | ---------------------- |
| `pet_id`         | 宠物 ID            | `kotori-minami`        |
| `pet_base_dir`   | 项目根目录         | `null`（自动检测）     |
| `socket_path`    | Unix socket 路径   | `/tmp/kotori-pet.sock` |
| `renderer.scale` | 缩放因子           | `0.6`                  |
| `renderer.fps`   | 帧率               | `10`                   |
| `state_map`      | 事件→动画+台词映射 | 见配置文件             |
| `menu.items`     | 右键菜单项         | 默认仅关闭宠物         |

## 脚本说明

入口脚本按平台分目录：`scripts/macos/`（`*.sh`）与 `scripts/windows/`（`*.ps1`），两套一一对应。

WSL2 额外提供 `scripts/wsl/setup-hooks.sh`，用于“Windows 渲染 + WSL agents”的分离工作流。

| 脚本（macOS / Windows）                  | 用途                                                   |
| ---------------------------------------- | ------------------------------------------------------ |
| `setup.sh` / `setup.ps1`                 | 全流程：安装依赖 → 生成配置 → 配置 hooks → 编译 → 启动 |
| `setup-hooks.sh` / `setup-hooks.ps1`     | 单独配置 hooks（Claude Code + Codex + OpenCode）       |
| `build-and-run.sh` / `build-and-run.ps1` | 单独编译并重启渲染器                                   |

## 技术栈

| 层   | 技术              | 说明                                 |
| ---- | ----------------- | ------------------------------------ |
| 后端 | Rust + Tauri v2   | 窗口管理、会话聚合、文件/Socket 监听 |
| 前端 | HTML + CSS + JS   | 精灵动画、对话气泡、交互             |
| 通信 | Tauri Event + IPC | Rust → JS 状态推送                   |
| 构建 | npm + Cargo       | 前端依赖 + Rust 编译                 |
| 日志 | `tracing`         | 结构化日志，支持 `RUST_LOG` 环境变量 |

## 安全设计

| 方面                 | 措施                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Socket 权限**      | Unix socket 文件权限 `0o600`，仅 owner 可连接，防止本地其他用户注入伪造状态                                                                                                              |
| **Socket 启动安全**  | 先 connect 探活再 remove + bind，避免 `/tmp` 下 TOCTOU symlink 攻击                                                                                                                      |
| **路径校验**         | `read_file_bytes` / `read_frames_batch` 校验请求路径在 `frames_dir` 内，防止 webview 任意文件读取                                                                                        |
| **AppleScript 沙箱** | `run_applescript` command 拒绝包含 `do shell script`、`do script` 或反引号的脚本，防止任意命令执行                                                                                       |
| **Socket 退出清理**  | `quit_app` 在 `app.exit()` 前显式删除 socket 文件（`app.exit()` 走 `process::exit()`，会跳过 Rust 的 `Drop`）；`SocketGuard` 兜底 panic 解退路径；启动探活兜底 crash/kill 后的残留文件   |
| **最小权限**         | capabilities 仅声明实际使用的窗口操作权限（`start-dragging` / `set-position` / `set-size` / `set-ignore-cursor-events`），事件权限由 `core:default` 统一授予，不含 `shell:allow-execute` |
| **Payload 限制**     | socket 接收上限 64KB，防止恶意超大 payload                                                                                                                                               |
| **无 shell 拼接**    | hook 不构造任何 shell 命令——session 文件生命周期（含 Stop 后的 2s 延迟删除与 5s 一次性窗口兜底）由 Rust 后端统一管理（socket 通道 + 文件扫描），无注入面                                 |
| **Mutex 安全**       | ActivityAggregator 所有可变状态合并为单个 `Mutex<Inner>`，消除死锁风险                                                                                                                   |

## IPC 与权限模型

后端通过 `#[tauri::command]` 暴露 8 个命令，全部在 `lib.rs` 的 `generate_handler!` 注册：

| 命令                 | 方向      | 用途                                                                    |
| -------------------- | --------- | ----------------------------------------------------------------------- |
| `get_config`         | JS ← Rust | 返回渲染所需的配置快照（帧目录、缩放、帧率、样式映射、菜单等）          |
| `read_file_bytes`    | JS → Rust | 读单帧 PNG 原始字节（绕过 WKWebView 画布污染，构造 untainted blob URL） |
| `read_frames_batch`  | JS → Rust | 批量读 55+ 帧（alpha-mask 计算，单次 IPC 替代多次往返）                 |
| `cursor_in_window`   | JS → Rust | 光标相对窗口客户区的逻辑像素坐标（hit-test 透传）                       |
| `run_applescript`    | JS → Rust | 执行 osascript（仅 macOS，拦截 `do shell script` 等危险模式）           |
| `purge_all_sessions` | JS → Rust | 三连击清空全部会话，返回删除文件数                                      |
| `quit_app`           | JS → Rust | 退出前显式删除 socket 文件，再 `app.exit(0)`                            |
| `js_log`             | JS → Rust | JS console 桥接到 Rust `tracing` 日志流                                 |

- **状态推送**：Rust 经 `app_handle.emit("state-change", ...)` 推送聚合后的显示态；JS 用 `listen("state-change", ...)` 订阅。
- **阻塞 I/O 离主线程**：`read_file_bytes` / `read_frames_batch` 为 `async` + `spawn_blocking`，文件系统调用不阻塞 webview 主线程或异步 worker。
- **权限**：`capabilities/default.json` 声明 `core:default`（含事件 listen/emit）+ 四个实际使用的 `core:window:*` 细粒度权限，无 `shell:*`。

> Tauri v2 合规的逐项核对见 [tauri-v2-compliance.md](tauri-v2-compliance.md)。
