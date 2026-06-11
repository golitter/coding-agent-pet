# Kotori Pet — 技术参考索引

> AGENTS.md 的详细参考库。涵盖文档清单、源码索引、Tauri IPC、配置、资源、运行时目录。
> 维护规则见 [prompts/AGENTS文档修正.md](../prompts/AGENTS文档修正.md)。

---

## 1. 文档索引

### 顶层文档 (`docs/`)

| 文档 | 内容 |
|---|---|
| [codex实现虚拟宠物.md](../codex实现虚拟宠物.md) | 通过 Codex Skill 生成宠物素材的教程 |
| [hooks.md](../hooks.md) | Codex / Claude Code 官方 Hooks 文档链接 |
| [prompts/AGENTS文档修正.md](../prompts/AGENTS文档修正.md) | AGENTS.md 文档规范（本文档的元规则） |

### 跨平台文档 (`desktop/docs/`)

| 文档 | 内容 |
|---|---|
| [overview.md](../../desktop/docs/overview.md) | 跨平台实现概述 + 系统架构图 + 安全设计 |
| [renderer.md](../../desktop/docs/renderer.md) | Tauri 渲染器详解（编译/运行/组件） |
| [spritesheet.md](../../desktop/docs/spritesheet.md) | 精灵图规格（1536×1872 · 8×9 网格 · 55 帧） |

### 设计文档 (`desktop/docs/design/`)

| 文档 | 内容 |
|---|---|
| [hit-test.md](../../desktop/docs/design/hit-test.md) | 透明像素点击穿透设计（alpha 蒙版 + CGEvent 轮询） |

### Hook 协议 (`desktop/docs/agent-hooks/`)

| 文档 | 内容 |
|---|---|
| [README.md](../../desktop/docs/agent-hooks/README.md) | Hook 索引 + 两平台对比 |
| [events.md](../../desktop/docs/agent-hooks/events.md) | 11 个 Claude 事件 + 9 个 Codex 事件对照表 + 清理规则 |
| [claude-code.md](../../desktop/docs/agent-hooks/claude-code.md) | Claude Code Hook 实现详解 |
| [codex.md](../../desktop/docs/agent-hooks/codex.md) | Codex Hook 实现详解 |

### Bugfix 计划 (`desktop/docs/bugfix/`)

| 文档 | 内容 | 状态 |
|---|---|---|
| [README.md](../../desktop/docs/bugfix/README.md) | Bugfix 计划索引 | — |
| [active-count-undercount.md](../../desktop/docs/bugfix/active-count-undercount.md) | 多会话计数 N-1 问题 | 已实施 |
| [idle-blink-too-fast.md](../../desktop/docs/bugfix/idle-blink-too-fast.md) | idle 状态眨眼太快 | 待实施 |

---

## 2. 源码索引

### Rust 后端 (`desktop/cross-platform/src-tauri/src/`)

| 文件 | 职责 |
|---|---|
| [main.rs](../../desktop/cross-platform/src-tauri/src/main.rs) | 入口，调用 `lib::run()` |
| [lib.rs](../../desktop/cross-platform/src-tauri/src/lib.rs) | 应用初始化 + 组件串联 |
| [config.rs](../../desktop/cross-platform/src-tauri/src/config.rs) | 配置加载 + 路径自动检测 |
| [commands.rs](../../desktop/cross-platform/src-tauri/src/commands.rs) | Tauri commands（前端 → Rust 入口，含 hit-test 支持） |
| [aggregator.rs](../../desktop/cross-platform/src-tauri/src/aggregator.rs) | 多会话聚合 + 优先级仲裁 + 磁盘对账 |
| [watcher.rs](../../desktop/cross-platform/src-tauri/src/watcher.rs) | 双通道状态监听（Unix socket 主 + 文件对账） |

### 前端 (`desktop/cross-platform/src/`)

| 文件 | 职责 |
|---|---|
| [index.html](../../desktop/cross-platform/src/index.html) | 主页面 DOM |
| [main.js](../../desktop/cross-platform/src/main.js) | 入口：窗口设置 + 交互绑定 |
| [animator.js](../../desktop/cross-platform/src/animator.js) | 精灵帧加载 + 动画循环引擎 |
| [bubble.js](../../desktop/cross-platform/src/bubble.js) | 对话气泡（normal / warning / error） |
| [style.css](../../desktop/cross-platform/src/style.css) | 全局样式（气泡 / 菜单 / 精灵渲染） |

### Hook 脚本 (`desktop/cross-platform/hooks/`)

| 文件 | 职责 |
|---|---|
| [pet-claude-hook.sh](../../desktop/cross-platform/hooks/pet-claude-hook.sh) | Claude Code hook 入口（shell wrapper） |
| [pet-codex-hook.sh](../../desktop/cross-platform/hooks/pet-codex-hook.sh) | Codex hook 入口（shell wrapper） |
| [scripts/common.py](../../desktop/cross-platform/hooks/scripts/common.py) | 共享逻辑：写 session 文件 + 推 socket |
| [scripts/claude_hook.py](../../desktop/cross-platform/hooks/scripts/claude_hook.py) | Claude Code 事件解析 |
| [scripts/codex_hook.py](../../desktop/cross-platform/hooks/scripts/codex_hook.py) | Codex 事件解析（snake_case → PascalCase） |

---

## 3. Tauri IPC（前端 → Rust）

| Command | 作用 |
|---|---|
| `get_config` | 返回前端使用的配置子集（`FrontendConfig`） |
| `quit_app` | 退出宠物进程 |
| `purge_all_sessions` | 清空所有 session 文件（三连击触发） |
| `run_applescript` | 执行 AppleScript（过滤 `do shell script` 和反引号） |
| `read_file_bytes` | 读 PNG 原始字节 → JS 构建未污染 blob URL（hit-test alpha 蒙版） |
| `cursor_in_window` | CGEvent 读硬件鼠标坐标（穿透态轮询恢复，仅 macOS） |

事件通道：Rust → JS 通过 `emit("agent-state", payload)` 推送聚合状态。

---

## 4. 核心配置 (`desktop/cross-platform/config.json`)

| 字段 | 默认值 | 说明 |
|---|---|---|
| `pet_id` | `kotori-minami` | 宠物 ID（决定资源目录） |
| `pet_base_dir` | `null` | 项目根，`null` 自动检测 |
| `socket_path` | `/tmp/kotori-pet.sock` | Unix socket 路径 |
| `stale_timeout_sec` | `3600` | session 文件过期阈值（秒），1h 覆盖长工具调用 |
| `renderer.scale` | `0.6` | 精灵缩放因子 |
| `renderer.fps` | `10` | 动画帧率 |
| `renderer.corner_margin` | `20` | 屏幕右下角边距 (px) |
| `dialogue.font_size` | `10` | 气泡字号 |
| `dialogue.max_width` | `160` | 气泡最大宽度 (px) |
| `state_map` | (见文件) | 事件 → `{state, dialogue}` 映射 |
| `menu.items` | (见文件) | 右键菜单项（Codex / VS Code / 关闭） |

完整模板见 [config.example.json](../../desktop/cross-platform/config.example.json)。

---

## 5. 脚本入口 (`desktop/cross-platform/`)

```bash
./setup.sh             # 全流程：依赖 → 配置 → hooks → 编译 → 启动
./setup-hooks.sh       # 单独配置 Claude Code + Codex hooks
./build-and-run.sh     # 单独编译并重启渲染器
npx tauri dev          # 开发热重载
npx tauri build        # 生产构建
npm run lint           # eslint + prettier 检查
npm run lint:fix       # 自动修复
```

日志级别：`RUST_LOG={error,warn,info,debug,trace}`，默认 `info`。

---

## 6. 资源目录 (`assets/kotori-minami/`)

```text
assets/kotori-minami/
├── frames/                        # 运行时动画帧（55 帧 PNG）
│   ├── frames-manifest.json       #   帧清单
│   ├── idle/                      #   6 帧（呼吸/眨眼循环）
│   ├── running/                   #   6 帧（活跃工作）
│   ├── running-left/              #   8 帧（向左拖动）
│   ├── running-right/             #   8 帧（向右拖动）
│   ├── jumping/                   #   5 帧（庆祝）
│   ├── waving/                    #   4 帧（问候/告别）
│   ├── waiting/                   #   6 帧（等授权）
│   ├── review/                    #   6 帧（审阅）
│   └── failed/                    #   8 帧（错误反应）
└── imagegen/                      # 生成流水线工件（不入运行时）
    ├── pet_request.json           #   宠物身份请求
    ├── imagegen-jobs.json         #   任务清单
    ├── prompts/base-pet.md        #   基础 prompt
    ├── prompts/rows/              #   每行动画 prompt
    ├── prompts/row-retries/       #   重试 prompt
    ├── references/                #   参考图
    ├── decoded/                   #   解码中间产物
    ├── qa/                        #   QA 预览
    └── final/                     #   最终 spritesheet.webp / spritesheet.png
```

规格细节见 [desktop/docs/spritesheet.md](../../desktop/docs/spritesheet.md)。

---

## 7. 运行时目录

| 路径 | 用途 |
|---|---|
| `desktop/cross-platform/runtime/sessions/{session_id}.json` | 各会话当前状态（hook 写、后端读） |
| `/tmp/kotori-pet.sock` | Unix socket — hook → 后端推送通道（权限 `0o600`） |
| `/tmp/kotori-pet-tauri.log` | Tauri 渲染器日志（`build-and-run.sh` 输出） |
| `/tmp/kotori-pet-codex-hook.log` | Codex hook 调试日志 |

---

## 8. 环境要求

- macOS 13+（当前已测试平台）
- [Rust](https://rustup.rs/) + Cargo
- Node.js + npm
- Python 3（系统自带，hook 脚本使用）

---

## 9. 状态优先级仲裁

`waiting > running > running-left/right > review > jumping > waving > idle > failed`

多会话同时活动时，按上表选出最高优先级状态作为宠物显示态。详见
[aggregator.rs](../../desktop/cross-platform/src-tauri/src/aggregator.rs) 与
[events.md "session 清理规则"](../../desktop/docs/agent-hooks/events.md)。
