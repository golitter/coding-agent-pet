# Windows 支持设计

> **状态：已实现**。本文为最初的设计提案（用将来时描述目标），落地记录见同目录 [windows-support-impl-report.md](windows-support-impl-report.md)。

## 背景

当前 `desktop/cross-platform` 名义上是跨平台 Tauri 实现，但实际运行路径里仍有多处 macOS / POSIX 假设：

- 事件实时通道使用 Unix Socket，Windows 原生不支持。
- `setup.sh`、`setup-hooks.sh`、`build-and-run.sh`、`pet-hook.sh` 都依赖 bash。
- Hook 配置目录写死为 `~/.claude`、`~/.codex`、`~/.config/opencode` 这类 Unix 风格路径。
- 默认假设 Claude Code、Codex、OpenCode 都已安装。
- 透明窗口的光标轮询命令 `cursor_in_window` 目前只实现了 macOS。

目标是在不破坏 macOS 现有行为的前提下，让 Windows 原生环境可以完成：

1. 启动 KotoriPet Tauri 应用。
2. 自动探测已安装的 Claude Code / Codex / OpenCode。
3. 只为已安装的 agent 写入 hook / plugin 配置。
4. 支持 Windows 上的本地事件实时推送。
5. 保持 session 文件兜底和多会话聚合行为一致。

## Windows 可用性依赖图

Windows 支持不是单点改造，而是四个子系统都要独立打通。任一子系统失败，都会表现为“应用能编译但不能像桌宠一样工作”。

| 子系统 | 当前状态 | 改造目标 | 验证方式 |
|---|---|---|---|
| 事件实时通道 | `tokio::net::UnixListener` / `UnixStream` 无条件编译，Windows 不通过 | Unix Socket 路径整体 `#[cfg(unix)]` 门控，Windows 默认 TCP loopback | Windows `cargo check` 通过；触发 hook 后动画即时更新 |
| 透明窗口渲染 | Tauri 配置已有 `transparent: true`，macOS 另有 Objective-C 强制透明；Windows 未核验 | 核对 Windows WebView2 透明效果，必要时补 Win32 窗口样式 | 启动后无矩形白底，透明区域可见桌面 |
| 配置 / hook 安装 | bash + Unix home 路径 + 假设 CLI 都存在 | Python 核心探测 CLI 和目录，PowerShell 只做薄包装，缺失工具跳过 | 未安装 CLI 时 setup 成功退出并列出 skipped |
| 光标穿透 / 悬停轮询 | `cursor_in_window` macOS-only | 增加 Windows Win32 坐标实现，保持 JS 无分叉 | 透明像素穿透后能恢复，悬停跳跃可触发 |

## 非目标

- 不自动安装 Claude Code、Codex、OpenCode。
- 不修改三方 CLI 的信任 / 授权模型；Codex 首次仍可能需要用户在 `/hooks` 中 Trust / Enable。
- 不在 Windows setup 中配置 WSL 内部的 agent。Windows 原生 CLI 和 WSL CLI 视为两个环境，用户需要在对应环境分别运行 setup。
- 不改变现有状态优先级、动画资源、菜单和交互语义。

## 总体方案

采用“跨平台核心 Python setup + 平台外壳脚本”的结构：

- `setup_hooks.py` 成为唯一 hook 配置核心。
- macOS / Linux 继续由 `setup-hooks.sh` 调用。
- Windows 新增 `setup-hooks.ps1` 调用同一个 Python 脚本。
- Windows 新增 `setup.ps1`、`build-and-run.ps1`，分别对应现有 `.sh` 脚本。
- 实时事件通道从“仅 Unix Socket”扩展为“Unix Socket 或 TCP loopback endpoint”。

推荐默认：

- macOS / Linux：兼容现有 Unix Socket 配置。
- Windows：默认使用 `tcp://127.0.0.1:17361`。

session 文件仍然保留为兜底通道。即使 TCP 推送失败，后端文件 watcher 仍可通过 `runtime/sessions/*.json` 同步状态。

## Agent 目录与安装探测

### 探测原则

setup 阶段先探测 CLI 是否已安装：

| Agent | 探测命令 |
|---|---|
| Claude Code | `claude`，必要时兼容 `claude-code` |
| Codex | `codex` |
| OpenCode | `opencode` |

实现上使用 Python `shutil.which()`，它会在 Windows 使用 `PATH` / `PATHEXT`，在 macOS / Linux 使用 `PATH`。

未检测到的 agent 直接跳过，不创建配置文件，不报错退出。最终输出汇总：

- 已配置的 agent。
- 未安装并跳过的 agent。
- 后续安装后应重新运行 `setup-hooks.ps1` 或 `setup-hooks.sh`。

### 配置目录解析

配置目录应由 `setup_hooks.py` 统一解析，不在 shell / PowerShell 中重复逻辑。

| Agent | macOS / Linux 默认 | Windows 默认 | 覆盖方式 |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | `%USERPROFILE%\.claude\settings.json` | `CLAUDE_CONFIG_DIR` 或 `hooks.claude_code_settings` |
| Codex | `~/.codex/hooks.json`，同目录 `config.toml` | `%USERPROFILE%\.codex\hooks.json`，同目录 `config.toml` | `CODEX_HOME` 或 `hooks.codex_hooks` |
| OpenCode | `~/.config/opencode/plugins/` | 待实机验证；优先使用 `OPENCODE_CONFIG_DIR`，否则暂按 `%USERPROFILE%\.config\opencode\plugins\` | `OPENCODE_CONFIG_DIR` 或 `hooks.opencode_plugins_dir` |

说明：

- `~` 在 Python 中通过 `Path.expanduser()` 展开。Windows 下通常解析到 `USERPROFILE` 或 `HOMEDRIVE` + `HOMEPATH`，但具体 agent 默认目录仍需在 Windows 原生环境验证。
- `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `OPENCODE_CONFIG_DIR` 若存在，优先于默认目录。
- `config.json` 中显式配置的路径优先级最高，用于高级用户手动指定。
- OpenCode 同时支持项目级 `.opencode/plugins/`，但本项目默认继续部署到用户级插件目录。项目级插件可作为后续增强。

### Hook 命令生成

macOS / Linux 继续注册：

```bash
<platform_dir>/hooks/pet-hook.sh claude-code
<platform_dir>/hooks/pet-hook.sh codex
```

Windows 注册时不依赖 bash，直接调用 setup 阶段探测到的 Python 可执行文件：

```powershell
"<python_exe>" "<platform_dir>\hooks\scripts\claude_hook.py"
"<python_exe>" "<platform_dir>\hooks\scripts\codex_hook.py"
```

为了保证命令字符串在 JSON 中可执行，Windows 路径必须加双引号。Python 脚本自身通过 `__file__` 反推 `desktop/cross-platform`，因此不需要额外参数。

实施时不能硬写 `python`。`setup_hooks.py` 应按顺序探测 `python`、`py -3`、`python3`，并把实际可用命令写进 hook 配置。Claude Code / Codex Windows hook runner 是否接受这种带引号命令，需要在 Windows 原生环境实测；若不接受，则改为写入一个 `.cmd` 包装器。

## 实时事件通道

### 配置模型

保留旧字段 `socket_path`，新增推荐字段 `event_endpoint`：

```json
{
  "event_endpoint": null,
  "socket_path": "/tmp/kotori-pet.sock"
}
```

解析规则：

1. 若 `event_endpoint` 是非空字符串，优先使用。
2. 若无 `event_endpoint`：
   - Windows 默认 `tcp://127.0.0.1:17361`
   - macOS / Linux 使用 `socket_path`，若缺失则 `/tmp/kotori-pet.sock`
3. 为兼容旧配置，`socket_path` 不立即删除。

Rust 端默认值必须按平台分支生成。不能继续让 `config.rs` 在 Windows 上回落到 `/tmp/kotori-pet.sock`，否则 Windows 会启动一个不可用的 Unix path endpoint。

### Rust 后端

`watcher.rs` 拆出统一入口：

```rust
pub async fn start_event_server(endpoint: &str, session_mgr: Arc<ActivityAggregator>)
```

内部根据 endpoint 分派：

- `tcp://host:port`：使用 `tokio::net::TcpListener`。
- 其他路径：
  - `#[cfg(unix)]` 使用现有 Unix Socket。
  - `#[cfg(windows)]` 记录警告并跳过，提示 Windows 需要 TCP endpoint。

现有 `start_socket_server` 不能只在内部加分支。它的整个 Unix Socket 函数体包含 `tokio::net::UnixStream::connect`、`tokio::net::UnixListener::bind` 和 accept 循环，这些 API 在 Windows target 下不可用。实现时应拆成：

- `start_event_server()`：跨平台入口，负责 endpoint 分派。
- `start_tcp_server()`：跨平台 TCP 实现。
- `#[cfg(unix)] start_unix_socket_server()`：现有 Unix Socket 实现整体搬入。
- `#[cfg(not(unix))]` 的 Unix path 分支只打印 warning，不引用任何 Unix API。

`lib.rs` 的调用点也必须从 `watcher::start_socket_server(&socket_path, ...)` 改为 `watcher::start_event_server(&event_endpoint, ...)`。

TCP server 行为与现有 Unix Socket 保持一致：

- 每次连接读取一个 JSON payload 到 EOF。
- payload 上限 64KB。
- 解析字段后调用 `ActivityAggregator::update()`。
- `Stop` 事件仍由后端延迟 2 秒移除 session。

协议约束：维持“一次连接只发送一个 payload，写完立即关闭”的模型。当前 Python 端不发送换行分隔符，OpenCode Node 端会写入换行，但 Rust 端以 EOF 分帧；因此不允许复用长连接，除非同时引入明确的 length-prefix 或 newline-delimited JSON 协议。

安全约束：

- 默认只监听 `127.0.0.1`，不监听 `0.0.0.0`。
- 若用户显式配置非 loopback 地址，启动时打印 warning。
- 不引入 shell 命令执行。

### Python Hooks

`common.py` 中把 `push_socket()` 替换或包裹为：

```python
def push_event(endpoint, payload):
    if endpoint.startswith("tcp://"):
        push_tcp(endpoint, payload)
    else:
        push_unix_socket(endpoint, payload)
```

Windows 下如果 endpoint 是 Unix path，则静默跳过并依靠 session 文件兜底。

`push_tcp()` 不能继承当前 `push_socket()` 的 `os.path.exists(socket_path)` 预检。`tcp://127.0.0.1:17361` 不是文件路径，`exists()` 永远为 false，会导致所有 TCP 推送被吞掉。TCP 分支应直接 connect，并在连接失败时用 `try/except` 静默降级。

hook 端读取配置时也要解析 `event_endpoint`，并保持与 Rust 后端同一套默认规则：

- Windows 无显式配置时使用 `tcp://127.0.0.1:17361`。
- macOS / Linux 无显式配置时使用 `socket_path`。
- 写 session 文件的路径解析必须与 Rust `PetConfig` 一致，避免实时通道失败时兜底文件写到不同目录。

### OpenCode Plugin

`opencode-shared.mjs` 同样新增 endpoint 分派：

- `tcp://127.0.0.1:17361` 使用 `net.createConnection({ host, port })`。
- Unix path 使用现有 `net.createConnection(path)`。

OpenCode plugin 继续 fire-and-forget，不等待推送完成，避免影响 OpenCode 主进程事件处理。

OpenCode 还依赖 `.kotori-pet-config-dir` companion 文件定位 `desktop/cross-platform`。Windows 实现必须明确该文件仍写在最终插件目录内，并写入 `platform_dir` 的绝对路径。Node 读取后使用 `path.resolve()` / `path.normalize()`，不要手写分隔符处理；当前 `toNativeImportPath()` 已处理 `file:///C:/...` 形态，需为 Windows 增加测试。

## Windows 启动脚本

### `setup.ps1`

职责对应 `setup.sh`：

1. 确保 `config.json` 存在，不存在则从 `config.example.json` 复制。
2. 安装 npm 依赖。
3. 调用 `setup-hooks.ps1`。
4. 调用 `build-and-run.ps1`。

### `setup-hooks.ps1`

只做薄包装：

```powershell
python "$PSScriptRoot\hooks\scripts\setup_hooks.py" "$PSScriptRoot"
```

Python 不存在时，提示安装 Python 3 或使用 `py -3`。实现可以优先尝试：

1. `python`
2. `py -3`

### `build-and-run.ps1`

职责对应 `build-and-run.sh`：

1. `npx tauri build --debug`
2. 停止旧进程。
3. 创建 `runtime/sessions`
4. 启动 `src-tauri\target\debug\kotori-pet.exe`
5. 日志写到 `runtime\kotori-pet-tauri.log`
6. 启动后检查进程是否仍存在

macOS 的 `xattr`、`pkill`、`nohup`、`disown` 不进入 PowerShell 脚本。

进程清理不要简单 `Stop-Process -Name kotori-pet` 杀掉所有同名进程。优先使用 `runtime\kotori-pet.pid` 记录本脚本启动的 PID；若 PID 不存在或进程已退出，再根据 TCP 端口占用做提示，而不是误杀用户手动启动的其他实例。

## Windows 透明窗口交互

Windows 桌宠可用性包含两个不同问题：

1. 窗口本体是否真正透明。
2. 透明像素穿透后的光标轮询是否能恢复交互。

`tauri.conf.json` 已设置 `transparent: true`、`decorations: false`、`shadow: false`、`skipTaskbar: true`。macOS 侧还用 Objective-C 强制 NSWindow / WKWebView 透明。Windows 实施前必须先验证 WebView2 在当前 Tauri 配置下是否已经透明；如果出现矩形白底，需要补 Windows 平台窗口样式，例如检查 layered / transparent 背景相关设置，而不是只实现 `cursor_in_window`。

`cursor_in_window` 当前只在 macOS 通过 CGEvent 实现。Windows 需要补等价逻辑，否则透明像素穿透后的恢复和悬停轮询会退化。

设计：

- 在 Rust 侧为 `#[cfg(target_os = "windows")]` 实现 `cursor_in_window`。
- 使用 Win32 API 获取全局 cursor position。
- 获取 Tauri window 外框 / 内容区域位置，将全局坐标换算为 window content logical pixels。
- 返回 `(x, y)`，保持 JS 层无需分叉。

依赖选择：

- 优先使用 `windows` crate 的最小 feature。
- 仅在 `target_os = "windows"` 下添加依赖。

若 Windows API 调用失败，返回错误。JS 已有降级逻辑，会停止轮询或依靠 DOM 事件恢复。

## 配置文件调整

`config.example.json` 建议调整：

```json
{
  "event_endpoint": null,
  "socket_path": "/tmp/kotori-pet.sock",
  "hooks": {
    "claude_code_settings": null,
    "codex_hooks": null,
    "opencode_plugins_dir": null
  }
}
```

含义：

- `null` 表示按平台自动探测。
- 旧用户已有字符串配置时继续生效。
- 文档中说明 Windows 默认会使用 TCP endpoint，不要求用户手写。

Rust `PetConfig` 增加 `event_endpoint` 字段；前端不需要感知。

同时修正 Rust `resolve_path()` 的 home 展开。当前实现只读取 `HOME`，Windows 下可能回落到 `/`。应改为：

1. Windows 优先 `USERPROFILE`，再回退 `HOMEDRIVE` + `HOMEPATH`，最后才尝试 `HOME`。
2. macOS / Linux 使用 `HOME`。
3. 或引入 `dirs` / `directories` crate 统一获取 home directory。

## 文件变更清单

| 操作 | 文件 |
|---|---|
| 修改 | `desktop/cross-platform/src-tauri/src/config.rs` |
| 修改 | `desktop/cross-platform/src-tauri/src/watcher.rs` |
| 修改 | `desktop/cross-platform/src-tauri/src/lib.rs` |
| 修改 | `desktop/cross-platform/src-tauri/src/commands.rs` |
| 修改 | `desktop/cross-platform/src-tauri/Cargo.toml` |
| 核对 / 可能修改 | `desktop/cross-platform/src-tauri/tauri.conf.json`，验证 Windows 透明窗口配置 |
| 核对 | `desktop/cross-platform/src-tauri/src/aggregator.rs`，确认 session 文件路径无平台分隔符假设 |
| 核对 | `desktop/cross-platform/src-tauri/src/main.rs`，确认现有 `windows_subsystem = "windows"` 无需修改 |
| 修改 | `desktop/cross-platform/config.example.json` |
| 修改 | `desktop/cross-platform/hooks/scripts/common.py` |
| 修改 | `desktop/cross-platform/hooks/scripts/setup_hooks.py` |
| 修改 | `desktop/cross-platform/hooks/opencode-shared.mjs` |
| 新增 | `desktop/cross-platform/setup.ps1` |
| 新增 | `desktop/cross-platform/setup-hooks.ps1` |
| 新增 | `desktop/cross-platform/build-and-run.ps1` |
| 修改 | `desktop/cross-platform/package.json`，让 hook 测试命令跨平台 |
| 修改 | README / agent hook 文档中关于平台和路径的说明 |

## 兼容与迁移

### 旧配置

已有 `config.json` 只包含 `socket_path` 时：

- macOS / Linux 行为不变。
- Windows 运行时自动选择 TCP 默认 endpoint，除非用户显式设置 `event_endpoint`。

注意：Rust 后端、Python hooks、OpenCode plugin 必须共享同一默认 endpoint 规则。否则会出现后端监听 TCP、hook 仍尝试 Unix path 的分裂状态。

### 旧 hook 条目

`setup_hooks.py` 的 managed hook 清理逻辑需要加入 Windows 命令片段：

- `pet-hook.sh claude-code`
- `pet-hook.sh codex`
- `claude_hook.py`
- `codex_hook.py`
- 旧的 `pet-claude-hook.sh`
- 旧的 `pet-codex-hook.sh`

这样重复运行 setup 不会累积多条 pet hook。

### 未安装 agent

示例输出：

```text
Configured:
  - Codex: C:\Users\me\.codex\hooks.json

Skipped:
  - Claude Code: command not found
  - OpenCode: command not found

Install skipped tools later, then rerun setup-hooks.ps1.
```

## 验证计划

### Windows

1. `cd desktop/cross-platform`
2. `powershell -ExecutionPolicy Bypass -File .\setup-hooks.ps1`
3. 未安装 agent 时确认脚本成功退出并列出 skipped。
4. 安装 Codex 后重跑，确认 `%USERPROFILE%\.codex\hooks.json` 写入 Python hook 命令。
5. `powershell -ExecutionPolicy Bypass -File .\build-and-run.ps1`
6. 确认 Tauri 应用启动，日志没有 Unix Socket panic。
7. 触发 Codex hook，确认：
   - `runtime\sessions\*.json` 写入。
   - TCP payload 能即时更新动画。
8. 观察窗口透明区域，确认没有矩形白底。
9. 在透明像素和实体像素之间移动鼠标，确认穿透、悬停、拖动、右键菜单仍可恢复。
10. 手动关闭宠物，确认旧进程清理正常。

### macOS / Linux

1. `bash setup-hooks.sh`
2. `bash build-and-run.sh`
3. 确认仍写入原有 `.sh` hook 命令。
4. 确认 Unix Socket 通道仍可用。
5. Codex 首次信任流程保持原样。

### 自动化

- `npm test`
- `cargo test`
- `cargo check`
- `cargo check --target x86_64-pc-windows-msvc`，或在 Windows 原生环境执行 `cargo check`
- Node OpenCode shared tests增加：
  - TCP endpoint 解析。
  - Unix path 兼容。
  - Windows `~` / home path 展开。
  - `.kotori-pet-config-dir` companion 文件路径为 Windows 绝对路径。
- Python hook tests增加：
  - 未安装 agent 时跳过。
  - Windows hook command 生成。
  - hook command 使用探测到的 Python 可执行文件，而不是硬写 `python`。
  - `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 优先级。
  - TCP 分支不调用 `os.path.exists()` 预检。

## 风险

| 风险 | 应对 |
|---|---|
| TCP 端口被占用 | 启动 warning，并依靠 session 文件兜底；后续可支持自动换端口 |
| Windows PowerShell 执行策略阻止脚本 | README 给出 `-ExecutionPolicy Bypass` 示例 |
| 用户在 WSL 中运行 agent，但在 Windows 启动宠物 | 文档明确需要在 WSL 内单独配置，或使用 Windows 原生 agent |
| OpenCode Windows 配置目录可能变化 | 支持 `OPENCODE_CONFIG_DIR` 和 `hooks.opencode_plugins_dir` 手动覆盖 |
| Codex 信任状态路径与 Windows 分隔符相关 | `setup_hooks.py` 生成 state key 时统一使用实际 settings path，并增加 Windows 单测 |
| Windows hook runner 不接受 `"<python_exe>" "<script>"` | 改为生成 `.cmd` 包装器，并在 hook 配置中写包装器路径 |
| session 兜底路径分裂 | 增加 Rust / Python 路径解析对照测试，确保默认 `sessions_dir` 一致 |

## 推荐实施顺序

1. 增加 endpoint 配置解析，修正 Rust / Python / OpenCode 的平台默认值一致性。
2. 拆分 `watcher.rs`：Unix Socket 全函数 `#[cfg(unix)]`，新增 TCP event server。
3. 改 Python / OpenCode 推送逻辑支持 TCP endpoint，并明确每连接一 payload、写完关闭。
4. 改 `setup_hooks.py`：平台路径、CLI 探测、缺失跳过、Windows command、OpenCode companion 文件。
5. 新增 PowerShell 脚本，使用 PID 文件避免误杀多实例。
6. 验证 Windows 透明窗口本体；必要时补 Windows 窗口样式。
7. 补 Windows `cursor_in_window`。
8. 更新 `package.json` 测试命令和相关单测。
9. 更新 README / agent hook 文档。
10. 在 Windows 原生环境跑完整 setup 验证。
