# Windows 平台支持 —— 实现报告

> 分支：`feat/windows-support` · 提交：`19d1ae2`（feat: 新增 Windows 平台支持）
> 相对基线：`e5697f9`（perf: idle 时 hit-test 轮询降频至 1Hz 省电）
> 日期：2026-06-17
> 设计依据：[windows-support.md](./windows-support.md)

## 0. 一句话概括

把原来写死 macOS/POSIX 的假设（Unix socket、`$HOME`、`/tmp`、`bash`、单分辨率 `.icns`）抽象成四条跨平台主线：**统一事件端点、跨平台家目录解析、Python 探测式 hook 命令、平台分发 shell 包装**；Windows 上以 **TCP loopback** 替代 Unix socket，其余路径/编码/分隔符问题逐处修补。

改动统计：23 文件，+1475 / -202。

---

## 1. 核心设计：事件端点（event endpoint）抽象

整组改动的主轴。原先前后端靠一个 Unix 域 socket 文件（`/tmp/kotori-pet.sock`）通信，Windows 没有（文件型）AF_UNIX，于是引入一个字符串字段 `event_endpoint`，按**前缀分发**到不同传输层。

### 默认值（三端必须一致，否则 split-brain）

| 平台 | 默认 endpoint |
|---|---|
| Windows / WSL | `tcp://127.0.0.1:17361` |
| macOS / Linux | `socket_path` 或 `/tmp/kotori-pet.sock` |
| 显式配置 | `config.event_endpoint` 始终优先 |

同样的判定逻辑在 **三个语言**里各实现一份并严格对齐：

- Rust：[config.rs:293-302](../../cross-platform/src-tauri/src/config.rs#L293-L302) `default_event_endpoint`
- Python：`hooks/scripts/common.py` `default_event_endpoint`（含 WSL 检测）
- TS：`hooks/opencode-shared.mjs` `defaultEventEndpoint`

### 传输分发

- `tcp://` 前缀 → TCP loopback
- 否则 → Unix socket（仅 Unix 编译进二进制）

---

## 2. Rust 后端

### 2.1 watcher.rs —— 统一入口 + TCP 后端

- **`start_event_server`**（新统一入口，[watcher.rs:33-52](../../cross-platform/src-tauri/src/watcher.rs#L33-L52)）：按 endpoint 前缀路由。`#[cfg(not(unix))]` 分支误传 Unix 路径时只打 warn，不 panic。
- **`start_tcp_server`**（新增，[watcher.rs:129-156](../../cross-platform/src-tauri/src/watcher.rs#L129-L156)）：`TcpListener::bind` loopback，每连接 `tokio::spawn`。L130-135 校验地址必须是 loopback（`127.`/`localhost:`/`[::1]:`），否则 warn "local event injection protection is reduced"——这是 TCP 相对 Unix socket 失去文件权限（0o600）保护后的**补偿性安全提示**。
- **`read_payload` 泛型化**（[watcher.rs:54-95](../../cross-platform/src-tauri/src/watcher.rs#L54-L95)）：把原 Unix 分支内联的「读到 EOF + 64KB 上限 + JSON 解析 + 延迟清理」抽成 `R: AsyncRead + Unpin` 共享函数，供 TCP/Unix 两路复用。
- **`start_unix_socket_server`** 整个函数加 `#[cfg(unix)]`（[watcher.rs:160](../../cross-platform/src-tauri/src/watcher.rs#L160)），Windows 上根本不存在，避免 `PermissionsExt` 等编译错误。
- **顺带修的 bug（非 Windows 专属）**：Stop 时的瞬时态清理，从只清 `Stop` + `jumping`，扩展到 `Stop || jumping || waving`（[watcher.rs:88](../../cross-platform/src-tauri/src/watcher.rs#L88)）。hook 进程是短命的，`threading.Timer` 会被杀，所以跳跃/挥手这种瞬时态需要后端兜底清。
- **文件兜底清理** `schedule_oneshot_cleanup_from_paths`（[watcher.rs:97-127](../../cross-platform/src-tauri/src/watcher.rs#L97-L127)）：session 文件 watcher reconcile 后，对 jumping/waving 态起 `std::thread` 睡 2s 再清——TCP 路径之外的文件兜底。

> 注意：watcher 是 **事件驱动**（`notify` crate，Windows 后端为 `ReadDirectoryChangesW`）+ 100ms debounce，**不是定时轮询**。idle 时 hit-test 轮询降频是上一个提交 `e5697f9` 的事，本次未动。

### 2.2 config.rs —— endpoint 字段 + 跨平台路径

- **字段**：`socket_path` → `event_endpoint`（[config.rs:13](../../cross-platform/src-tauri/src/config.rs#L13)）。`RawConfig` 同时保留 `socket_path` 做**向后兼容**（[config.rs:54](../../cross-platform/src-tauri/src/config.rs#L54)），`unwrap_or_else` 回落链：`event_endpoint` → `socket_path` → 平台默认（[config.rs:127-129](../../cross-platform/src-tauri/src/config.rs#L127-L129)）。
- **家目录解析** `home_dir_string`（[config.rs:271-291](../../cross-platform/src-tauri/src/config.rs#L271-L291)）：Windows 按 `USERPROFILE` → `HOMEDRIVE+HOMEPATH` 顺序，回落 `HOME`。原代码直接 `var("HOME")`，Windows 上常没有。
- **路径分隔符**：去硬编码 `/`，改用 `join_path_string`（`PathBuf::push` 走原生分隔符），[config.rs:172-178](../../cross-platform/src-tauri/src/config.rs#L172-L178)、[config.rs:263-269](../../cross-platform/src-tauri/src/config.rs#L263-L269)。
- 测试改用 `Path::new(...).join(...)` 比较而非字符串字面量，并加 `#[cfg(windows)]` 分支。

### 2.3 commands.rs —— cursor_in_window 的 Windows 实现

悬停跳跃需要「光标是否在窗口内」。原先 Windows 直接报错不可用：

- 新增 `#[cfg(target_os = "windows")]` 分支（[commands.rs:232-262](../../cross-platform/src-tauri/src/commands.rs#L232-L262)）：`extern "system"` FFI `#[link(name = "user32")]` 调 `GetCursorPos` → 屏幕坐标减 `window.outer_position()` → 除 `scale_factor()` 做 DPI 缩放 → 返回逻辑像素 (x, y, from top)。
- macOS 分支不变；其余平台报 "only available on macOS and Windows"。
- `quit_app` 清理：TCP 端点没有文件可删，`if !event_endpoint.starts_with("tcp://")` 守卫（[commands.rs:95-97](../../cross-platform/src-tauri/src/commands.rs#L95-L97)）。

### 2.4 lib.rs —— 入口路由

- `SocketGuard` 字段 `path` → `endpoint`，`Drop` 里 TCP 端点跳过 `remove_file`（[lib.rs:62-67](../../cross-platform/src-tauri/src/lib.rs#L62-L67)）。
- 启动调用 `start_socket_server` → `start_event_server`（[lib.rs:134-136](../../cross-platform/src-tauri/src/lib.rs#L134-L136)）。

---

## 3. Hooks（Python 核心 + TS 同构）

### 3.1 common.py —— 事件上报

- `default_event_endpoint`：同 Rust 逻辑，WSL 单独判定（看 `WSL_DISTRO_NAME`/`WSL_INTEROP`/`/proc/version` 含 `microsoft`）。
- `push_event` 分发：`tcp://` → `push_tcp`（`urllib.parse` 解析、`socket.create_connection` 超时 0.1s）；非 Windows 非 TCP → `push_unix_socket`。Windows 上若 endpoint 不是 TCP **静默丢弃**，避免尝试 Unix socket。
- **编码补强**：`read_stdin_json` 用 `sys.stdin.buffer.read()` + `utf-8-sig` 解码吞 BOM（PowerShell/cmd 管道会注入 BOM）；所有 JSON 读写显式 `encoding='utf-8'`。

### 3.2 setup_hooks.py —— 平台检测 + hook 命令构造

这是「装在哪」决策的中枢：

- **Python 探测** `detect_python_command`：Windows 候选顺序 `python` → `py -3` → `python3`，逐个用 `shutil.which(parts[0])` 验证存在，**返回裸命令名**（如 `python`），不解析成绝对路径。macOS/Linux 顺序为 `python3` → `python`。
- **裸命令名而非绝对路径**（迭代教训）：早期实现用 `shutil.which` 解析成 `python.exe` 的绝对路径写入 settings.json，结果路径里出现 `miniconda`/`Python314` 等特定环境名，python 升级/重装即失效。改为裸命令名后，hook 脚本仅依赖标准库（json/os/socket/sys/datetime/pathlib/urllib），任何 PATH 上的 python 都能跑，可随环境迁移。
- **hook 命令二分支**（[setup_hooks.py build_targets](../../cross-platform/hooks/scripts/setup_hooks.py)）：
  1. Windows + 原生 python → `python <脚本路径>`，如 `python D:/Graduate/.../claude_hook.py`
  2. macOS / Linux → 沿用 `pet-hook.sh claude-code` / `pet-hook.sh codex`

  > **已删除 WSL 分支**：早期版本会探测 WSL bash + python3 并优先生成 `python3 /mnt/d/...` 命令。但 Claude Code 是原生 Windows 进程，无法执行该命令串；即便在 WSL 内跑，文件事件与 TCP 也穿透不了子系统边界，导致宠物收不到消息。纯 Windows 方案下该分支已彻底移除（含 `detect_wsl_python_for_path` / `windows_path_to_wsl` / `build_wsl_hook_command` / `command_succeeds` 四个辅助函数）。
- **脚本路径必须用正斜杠**（`to_forward_slash`）：Claude Code/Codex 在 Windows 上通过 **sh（Git Bash）** 执行 hook 命令。若脚本路径含反斜杠（`D:\...\claude_hook.py`），sh 会把反斜杠当转义符吞掉，路径被破坏成 `D:...claude_hook.py` → 找不到文件 → hook 静默失败 → 宠物收不到任何事件。`to_forward_slash` 统一转为 `/`，sh 与 cmd 均可正确解析。详见 [§ 已知坑：sh 反斜杠转义](#已知坑sh-反斜杠转义)。
- **Codex 多平台字段**：除 `command` 外，`command_windows` 有值时额外写 `commandWindows`（Codex schema 区分平台的 key），同样用裸 python + 正斜杠脚本路径。清理时同时匹配 `command`/`commandWindows`/`command_windows` 三种历史写法。
- **配置路径**：**不是** `~/.claude` → `%USERPROFILE%\.claude` 的字符串替换，而是依赖 `Path.expanduser()` 跨平台解析，并支持 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`OPENCODE_CONFIG_DIR` 环境变量覆盖。
- **缺工具不报错**：`is_tool_available` 探测 Claude/Codex 是否安装，缺失则 skip 并打印清单。

### 3.3 claude_hook.py / codex_hook.py

写死的 `/tmp/...` 日志路径改到 `platform_dir/runtime/hook-events.log`——彻底规避 `/tmp` 在 Windows 上不存在。

### 3.4 opencode-shared.mjs / opencode-plugin.ts

TS 侧与 Python 同构：`defaultEventEndpoint` / `pushEvent` / `pushTcp` / `resolveHomeDir`（`USERPROFILE` → `HOMEDRIVE+HOMEPATH` → `/`）逐一对应。旧导出名 `pushSocket` 作为 `pushUnixSocket` 别名保留。

---

## 4. Windows 启动脚本（PowerShell）

对标三个 `.sh`，职责清晰：

| 脚本 | 对标 | 职责 |
|---|---|---|
| `setup.ps1` | `setup.sh` | 一键：把 `.cargo\bin` + MSVC toolchain 临时加 PATH → 复制 config.json → `npm install` → 调 setup-hooks.ps1 → 调 build-and-run.ps1 |
| `setup-hooks.ps1` | `setup-hooks.sh` | Python 启动器：探测 `python`→`py -3`→`python3`，调 `setup_hooks.py`，透传退出码 |
| `build-and-run.ps1` | `build-and-run.sh` | `npx tauri build --debug` → 建 `runtime/sessions` → 读 `runtime/kotori-pet.pid` 杀旧进程 → 后台启动（stdout/stderr 重定向到日志）→ 写新 PID |

进程生命周期用 PID 文件而非 `Stop-Process -Name`，避免误杀用户手动启动的其它实例。

---

## 5. 配置与工程文件

### config.example.json

```diff
+ "event_endpoint": null,
  "hooks": {
-   "claude_code_settings": "~/.claude/settings.json",
-   "codex_hooks": "~/.codex/hooks.json",
-   "opencode_plugins_dir": "~/.config/opencode/plugins"
+   "claude_code_settings": null,
+   "codex_hooks": null,
+   "opencode_plugins_dir": null
  }
```

意图：示例配置不再为某一平台写死路径，交给 `setup_hooks.py` 自动检测（`config_path_or_default` 消费 null）。`event_endpoint: null` 让示例平台中立。

### package.json — test:hooks 去 uv

```diff
- "test:hooks": "UV_CACHE_DIR=.uv-cache uv run python -m unittest ... && node --test hooks/tests/*.test.mjs"
+ "test:hooks": "python -m unittest ... && node --test hooks/tests/opencode-shared.test.mjs"
```

去掉 `uv`（Windows 非必装），glob 收窄到显式文件名（避免不同 shell 的 glob 差异）。

---

## 6. 前端 animator.js（Windows 专属）

三处改动，**都**与 Windows 相关，不是独立渲染修复：

1. **`loadImage` 绕开 asset 协议**（[animator.js:64-94](../../cross-platform/src/animator.js#L64-L94)）：优先 `invoke("read_file_bytes")` 拿原始字节 → 包成 PNG `Blob` → `blob:` object URL 给 `img.src`；失败才回落 `convertFileSrc`。原因：Tauri asset 协议在 Windows WebView2 上对反斜杠/绝对路径有编码特性，常致精灵帧加载失败。> ⚠️ blob URL 当前没有 `URL.revokeObjectURL`，存在轻微内存泄漏。
2. **basename 分隔符**（[animator.js:143](../../cross-platform/src/animator.js#L143)）：`split("/")` → `split(/[\\/]/)`，兼容 Windows 反斜杠路径。
3. **`js_log` IPC**（[animator.js:177-183](../../cross-platform/src/animator.js#L177-L183)）：帧加载摘要通过 `invoke("js_log")` 转发到 Rust 控制台。原因：透明、无装饰、跳过任务栏的窗口在 Windows 上很难附着 WebView2 devtools，JS 日志走 IPC 才可见。

---

## 7. 测试

两套测试共同模式：写死的 `/repo/...` 断言过一层 `norm()`（Python）/ `path.normalize()`（JS），让 Windows 反斜杠/盘符路径仍通过。

新增覆盖：UTF-8 中文 dialogue 读取、`commandWindows` 写入、Windows 路径加引号、`default_event_endpoint` 显式值优先、`loadPluginRuntime` 处理带空格盘符的 `file://` URL。

> 注：早期版本含 WSL 路径转换（`windows_path_to_wsl`/`build_wsl_hook_command`）测试用例，纯 Windows 方案下已随实现一并删除。

---

## 8. husky pre-commit 平台分发（本次额外修掉的环境问题）

原 `.husky/pre-commit` 是纯 POSIX sh 脚本，Windows 上 `python3`/`cargo`/`shellcheck`/`ruff` 命令名或 PATH 不同，导致 husky 报 `code 127`（command not found），提交失败。

改为**平台分发**：

- [.husky/pre-commit](../../cross-platform/.husky/pre-commit)：检测到 `MINGW*|MSYS*|CYGWIN*` 就 `pwsh`（回落 `powershell`）执行 [.husky/pre-commit.ps1](../../cross-platform/.husky/pre-commit.ps1)；否则继续走原 sh 逻辑。
- **pre-commit.ps1**：用 `Get-Command` 探测式调用每个工具——`cargo`/`shellcheck`/`python`(`python3`)/`ruff`，装了就强校验，没装就明确提示跳过（不静默放行、不抛错中断）。已用 PowerShell Parser 验证语法，并在本次提交中实测跑通（lint-staged 通过、cargo 未在 PATH 时明确 skip）。

---

## 9. 已知遗留 / 待办

1. **`icon.ico` 是占位**：仅 105 字节，单帧 32×32 PNG-in-ICO。能让构建通过，但缺 16/48/128/256 等多分辨率，任务栏/ALT-TAB/高 DPI 下会糊。设计文档甚至没提图标工作——这是「让构建过」的临时产物，应替换为正规多分辨率 ICO。
2. **animator blob URL 内存泄漏**：`loadImage` 生成的 object URL 未 revoke，长期运行/频繁换帧会累积。
3. **透明窗口未在文档外验证**：设计文档把「WebView2 是否真透明」「白色矩形时才加 Win32 窗口样式」列为待验证项，本次代码未见对应的 Win32 样式处理，需实机确认。
4. **husky `_` 目录不入库**：husky 9 的 `.husky/_/` 被自身 `.gitignore` 屏蔽，新克隆需在 `desktop/cross-platform` 跑 `npm run prepare`（`husky` 初始化）才能生效——应在 Windows 安装文档里写明。

---

## 10. 验证矩阵（建议）

| 项 | macOS | Windows 原生 |
|---|---|---|
| Unix socket / TCP 事件通道 | socket | tcp://17361 |
| 悬停跳跃（cursor_in_window） | ✅ | ✅ GetCursorPos |
| 精灵帧加载 | asset 协议 | blob URL |
| hook 安装（Claude/Codex/OpenCode） | pet-hook.sh | python（裸名 + 正斜杠） |
| `npm test` | ✅ | ✅（去 uv） |
| husky pre-commit | sh | ps1 |

> 说明：纯 Windows 方案下不再支持/测试 WSL 链路，相关列已移除。

---

## 11. 已知坑：sh 反斜杠转义（实战排错记录）

Windows 支持落地后，曾出现「发消息但宠物始终收不到」的顽固故障。根因不在 hook 脚本逻辑，而在 **hook 命令的路径分隔符**：

- **现象**：`runtime/hook-events.log` 无新记录，App 日志只有 hit-test，`runtime/sessions/` 一直为空——hook 根本没被执行。
- **根因**：Claude Code/Codex 在 Windows 上用 **sh（Git Bash）** 执行 settings.json 里的 hook 命令。`setup_hooks.py` 早期写入的脚本路径是反斜杠 `D:\...\claude_hook.py`，sh 把反斜杠当转义符逐个吞掉，路径变成 `D:...claude_hook.py`，sh 报 `command not found`，hook 静默失败。
- **复现**：`echo '{...}' | sh -c 'D:\path\python.exe D:\path\hook.py'` → `sh: D:pathpython.exe: command not found`。
- **修复**：所有写入 settings.json 的路径统一用正斜杠（`to_forward_slash`）。正斜杠在 sh 与 cmd 下都能正确解析。
- **教训**：Windows 原生进程 ≠ 它的 hook runner 用 cmd。agent CLI（Claude Code/Codex）跨平台用 sh 执行 hook，因此 Windows 下任何写入 hook 配置的路径都必须 sh-safe（正斜杠）。

## 12. 已知坑：python 绝对路径写死（实战排错记录）

紧接上一个坑修复后的迭代：

- **现象**：路径改正斜杠后链路通了，但 settings.json 里写的是 `C:/Python314/python.EXE D:/.../claude_hook.py`——硬编码到具体 python 安装位置。
- **问题**：用户换 miniconda、升级到 Python 3.15、或重装到别处，绝对路径立即失效，需重跑 setup-hooks。且不同机器路径不同，配置不可移植。
- **修复**：`detect_python_command` 改为返回**裸命令名**（Windows 顺序 `python` → `py -3` → `python3`，仅用 `shutil.which` 验证存在）。最终命令形如 `python D:/.../claude_hook.py`。
- **前提**：hook 脚本（`claude_hook.py`/`codex_hook.py`/`common.py`）**仅依赖 Python 标准库**（json/os/socket/sys/datetime/pathlib/urllib），零第三方依赖，故任何 PATH 上的 python 均可执行，无需虚拟环境或绝对路径。
- **取舍**：裸命令名依赖 hook runner 的 PATH 含 python。Windows 上从 GUI/精简环境启动 Claude Code 时 PATH 可能缺 python，但这是少数场景且安装文档会提示装 python；权衡后裸名的可移植性优势更大。
