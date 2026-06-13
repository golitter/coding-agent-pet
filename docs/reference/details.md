# Kotori Pet — 技术参考索引

> AGENTS.md 的详细参考库。涵盖文档清单、源码索引、Tauri IPC、配置、资源、运行时目录。
> 维护规则见 [prompts/AGENTS文档修正.md](../prompts/AGENTS文档修正.md)。

---

## 1. 文档索引

### 已验证的 AI Coding CLI 版本

当前仓库中的 Hooks / 插件集成已按下列版本完成联调：

- Claude Code：`2.1.81`
- OpenCode：`1.17.3`
- Codex CLI：`0.139.0`

这些版本信息尤其影响 `desktop/docs/agent-hooks/`、`desktop/cross-platform/hooks/` 与 `setup-hooks.sh` 的行为判断；若上游 CLI 更新了 Hook 协议或插件接口，文档和实现都可能需要同步调整。

### 顶层文档 (`docs/`)

| 文档 | 内容 |
|---|---|
| [codex实现虚拟宠物.md](../codex实现虚拟宠物.md) | 通过 Codex Skill 生成宠物素材的教程 |
| [hooks.md](../hooks.md) | Codex / Claude Code 官方 Hooks 文档链接 |
| [prompts/AGENTS文档修正.md](../prompts/AGENTS文档修正.md) | AGENTS.md 文档规范（本文档的元规则） |

### 跨平台文档 (`desktop/docs/reference/`)

| 文档 | 内容 |
|---|---|
| [overview.md](../../desktop/docs/reference/overview.md) | 跨平台实现概述 + 系统架构图 + 安全设计 |
| [renderer.md](../../desktop/docs/reference/renderer.md) | Tauri 渲染器详解（编译/运行/组件） |
| [spritesheet.md](../../desktop/docs/reference/spritesheet.md) | 精灵图规格（1536×1872 · 8×9 网格 · 57 帧） |

### 设计文档 (`desktop/docs/design/`)

| 文档 | 内容 |
|---|---|
| [hit-test.md](../../desktop/docs/design/hit-test.md) | 透明像素点击穿透设计（alpha 蒙版 + CGEvent 轮询） |
| [hooks-refactor.md](../../desktop/docs/design/hooks-refactor.md) | Hook 重构设计（合并冗余 wrapper → 统一 pet-hook.sh） |
| [opencode-plugin.md](../../desktop/docs/design/opencode-plugin.md) | OpenCode 插件设计（事件映射 + 独立调试） |
| [opencode-integration-plan.md](../../desktop/docs/design/opencode-integration-plan.md) | OpenCode 集成计划 |

### Hook 协议 (`desktop/docs/agent-hooks/`)

| 文档 | 内容 |
|---|---|
| [README.md](../../desktop/docs/agent-hooks/README.md) | Hook 索引 + 三平台对比 |
| [events.md](../../desktop/docs/agent-hooks/events.md) | 11 个 Claude 事件 + 9 个 Codex 事件 + 8 个 OpenCode 事件对照表 + 清理规则 |
| [claude-code.md](../../desktop/docs/agent-hooks/claude-code.md) | Claude Code Hook 实现详解 |
| [codex.md](../../desktop/docs/agent-hooks/codex.md) | Codex Hook 实现详解 |
| [opencode.md](../../desktop/docs/agent-hooks/opencode.md) | OpenCode 插件系统参考（事件、Hook API、宠物集成） |

### Bugfix 计划 (`desktop/docs/bugfix/`)

| 文档 | 内容 | 状态 |
|---|---|---|
| [README.md](../../desktop/docs/bugfix/README.md) | Bugfix 计划索引 | — |
| [active-count-undercount.md](../../desktop/docs/bugfix/active-count-undercount.md) | 多会话计数 N-1 问题 | 已实施 |
| [idle-blink-too-fast.md](../../desktop/docs/bugfix/idle-blink-too-fast.md) | idle 状态眨眼太快 | 已实施 |
| [pet-unresponsive-stuck-state.md](../../desktop/docs/bugfix/pet-unresponsive-stuck-state.md) | 宠物无响应/拖动卡死 | 已实施 |

---

## 2. 源码索引

### Rust 后端 (`desktop/cross-platform/src-tauri/src/`)

| 文件 | 职责 |
|---|---|
| [main.rs](../../desktop/cross-platform/src-tauri/src/main.rs) | 入口，调用 `lib::run()` |
| [lib.rs](../../desktop/cross-platform/src-tauri/src/lib.rs) | 应用初始化 + 组件串联 |
| [config.rs](../../desktop/cross-platform/src-tauri/src/config.rs) | 配置加载 + 路径自动检测 |
| [commands.rs](../../desktop/cross-platform/src-tauri/src/commands.rs) | Tauri commands（前端 → Rust 入口，含 hit-test 支持） |
| [aggregator.rs](../../desktop/cross-platform/src-tauri/src/aggregator.rs) | 多会话聚合 + 优先级仲裁 + 增量路径对账（upsert 语义） |
| [watcher.rs](../../desktop/cross-platform/src-tauri/src/watcher.rs) | 双通道状态监听（Unix socket 主 + 变更路径防抖对账） |

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
| [pet-hook.sh](../../desktop/cross-platform/hooks/pet-hook.sh) | Shell 入口（claude-code / codex 参数分派） |
| [opencode-plugin.ts](../../desktop/cross-platform/hooks/opencode-plugin.ts) | OpenCode 插件（TS，进程内运行，`setup-hooks.sh` 部署到 `~/.config/opencode/plugins/`） |
| [opencode-shared.mjs](../../desktop/cross-platform/hooks/opencode-shared.mjs) | OpenCode 共享逻辑：配置加载、pet_base_dir 解析、事件映射、payload 构建、session/socket IO（debug 受 `KOTORI_PET_OPENCODE_DEBUG` 环境变量控制） |
| [scripts/common.py](../../desktop/cross-platform/hooks/scripts/common.py) | 共享逻辑：pet_base_dir 解析、写 session 文件 + 推 socket |
| [scripts/claude_hook.py](../../desktop/cross-platform/hooks/scripts/claude_hook.py) | Claude Code 事件解析 |
| [scripts/codex_hook.py](../../desktop/cross-platform/hooks/scripts/codex_hook.py) | Codex 事件解析（snake_case → PascalCase） |
| [scripts/setup_hooks.py](../../desktop/cross-platform/hooks/scripts/setup_hooks.py) | Hook 注册逻辑（由 `setup-hooks.sh` 内联调用） |
| [scripts/test_hooks.py](../../desktop/cross-platform/hooks/scripts/test_hooks.py) | Python 轻量测试：Codex 事件别名、hook 配置写入、Codex enable 行为 |
| [tests/opencode-shared.test.mjs](../../desktop/cross-platform/hooks/tests/opencode-shared.test.mjs) | Node 轻量测试：OpenCode 事件映射、payload、配置回退逻辑 |

---

## 3. Tauri IPC（前端 → Rust）

| Command | 作用 |
|---|---|
| `get_config` | 返回前端使用的配置子集（`FrontendConfig`） |
| `quit_app` | 退出宠物进程 |
| `purge_all_sessions` | 清空所有 session 文件（三连击触发） |
| `run_applescript` | 执行 AppleScript（过滤 `do shell script`、`do script` 和反引号） |
| `read_file_bytes` | 读 PNG 原始字节，路径校验限制在 `frames_dir` 内（hit-test alpha 蒙版） |
| `read_frames_batch` | 批量读取多帧 PNG，单次 IPC 替代 57 次 `read_file_bytes`（两级路径校验：lexicle 快路径 + canonicalize 慢路径） |
| `cursor_in_window` | CGEvent 读硬件鼠标坐标（穿透态轮询恢复，仅 macOS） |
| `js_log` | JS → Rust 日志桥接，前端诊断信息输出到 `RUST_LOG` 流（`info`/`warn`/`error` 级别） |

事件通道：Rust → JS 通过 `emit("agent-state", payload)` 推送聚合状态。

---

## 4. 核心配置 (`desktop/cross-platform/config.json`)

| 字段 | 默认值 | 说明 |
|---|---|---|
| `pet_id` | `kotori-minami` | 宠物 ID（决定资源目录） |
| `pet_base_dir` | `null` | 项目根，`null` 自动检测 |
| `frames_dir` | `null` | 精灵帧目录，`null` 自动检测（`{pet_base_dir}/assets/{pet_id}/frames`） |
| `socket_path` | `/tmp/kotori-pet.sock` | Unix socket 路径 |
| `sessions_dir` | `null` | session 文件目录，`null` 自动检测（`{pet_base_dir}/desktop/cross-platform/runtime/sessions`） |
| `stale_timeout_sec` | `3600` | session 文件过期阈值（秒），1h 覆盖长工具调用 |
| `renderer.cleanup_interval_sec` | `30` | 定时清理间隔（秒）：扫描过期文件、孤儿内存会话、过期的一次性庆祝（`jumping`/`waving`）文件 |
| `renderer.scale` | `0.6` | 精灵缩放因子 |
| `renderer.fps` | `10` | 动画帧率 |
| `renderer.corner_margin` | `20` | 屏幕右下角边距 (px) |
| `dialogue.font_size` | `10` | 气泡字号 |
| `dialogue.max_width` | `160` | 气泡最大宽度 (px) |
| `dialogue.cornerRadius` | `6` | 气泡圆角 (px) |
| `dialogue.fade_duration_sec` | `0.3` | 气泡淡入/淡出过渡时长 (秒) |
| `dialogue.style_map` | `{waiting: warning, failed: error}` | 宠物状态 → 气泡 CSS 样式映射 |
| `hooks.claude_code_settings` | `~/.claude/settings.json` | Claude Code settings 路径 |
| `hooks.codex_hooks` | `~/.codex/hooks.json` | Codex hooks 配置路径 |
| `hooks.opencode_plugins_dir` | `~/.config/opencode/plugins` | OpenCode 插件部署目录 |
| `terminal_events` | `["StopFailure", "SessionEnd"]` | terminal 事件列表（触发立即删除 session 文件） |
| `state_map` | (见文件) | 事件 → `{state, dialogue}` 映射 |
| `menu.items` | (见文件) | 右键菜单项（默认仅关闭宠物） |

完整模板见 [config.example.json](../../desktop/cross-platform/config.example.json)。

---

## 5. 脚本入口 (`desktop/cross-platform/`)

```bash
bash setup.sh          # 正式推荐：全流程 依赖 → 配置 → hooks → 编译 → 启动
./setup-hooks.sh       # 单独配置 Claude Code + Codex + OpenCode hooks
./build-and-run.sh     # 开发辅助：单独编译并重启渲染器
npm test               # hooks 轻量测试（别名 → test:hooks）
npm run test:hooks     # hooks 轻量测试（Python unittest + Node --test，uv 缓存至 .uv-cache）
npx tauri dev          # 开发热重载
npx tauri build        # 生产构建
npm run lint           # eslint + prettier 检查
npm run lint:fix       # 自动修复
```

`setup-hooks.sh` 是幂等的：每次会先清掉它自己管理的 pet hook，再写回一份标准配置，因此不会重复追加。
对于 Codex，它会自动写入 `~/.codex/hooks.json`，并尝试把已有 `trusted_hash` 的 pet hook 状态补成 `enabled = true`；首次使用通常仍需在 `/hooks` 中手动 `Trust/Enable` 一次。

日志级别：`RUST_LOG={error,warn,info,debug,trace}`，默认 `info`。

---

## 6. 资源目录 (`assets/kotori-minami/`)

```text
assets/kotori-minami/
├── frames/                        # 运行时动画帧（57 帧 PNG）
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

规格细节见 [desktop/docs/reference/spritesheet.md](../../desktop/docs/reference/spritesheet.md)。

---

## 7. 运行时目录

| 路径 | 用途 |
|---|---|
| `desktop/cross-platform/runtime/sessions/{session_id}.json` | 各会话当前状态（hook 写、后端读） |
| `/tmp/kotori-pet.sock` | Unix socket — hook → 后端推送通道（权限 `0o600`） |
| `/tmp/kotori-pet-tauri.log` | Tauri 渲染器日志（`build-and-run.sh` 输出） |
| `/tmp/kotori-pet-codex-hook.log` | Codex hook 调试日志 |
| `/tmp/kotori-pet-opencode-debug.log` | OpenCode 插件调试日志 |
| `~/.config/opencode/plugins/pet-plugin.ts` | OpenCode 插件部署路径（由 `setup-hooks.sh` 自动复制） |
| `~/.config/opencode/plugins/.kotori-pet-config-dir` | OpenCode 插件同伴文件（指向 `desktop/cross-platform/` 路径） |

---

## 8. 环境要求

- macOS 13+（当前已测试平台）
- [Rust](https://rustup.rs/) + Cargo
- Node.js + npm
- Python 3（系统自带，hook 脚本使用）

---

## 9. 状态优先级仲裁

`waiting > running > running-left/right > review > jumping > waving > idle > failed`

多会话同时活动时，按上表选出最高优先级状态作为宠物显示态。`get_priority()` 使用 `match` 表达式 O(1) 查找（替代线性扫描），详见
[aggregator.rs](../../desktop/cross-platform/src-tauri/src/aggregator.rs) 与
[events.md "session 清理规则"](../../desktop/docs/agent-hooks/events.md)。
