# Tauri v2 合规审查

> 审查依据：项目内置的 `tauri-v2` skill（`.claude/skills/tauri-v2`）。
> 该 skill 归纳了 Tauri v2 跨平台开发的「必做 / 禁止」清单与常见踩坑。
> 本文把 skill 的检查项逐条对照本项目实现，记录结论与本次修复。

- 审查日期：2026-06-17
- Tauri 版本：`2.11.2`（见 `src-tauri/Cargo.lock`）
- 审查范围：`desktop/cross-platform/src-tauri/`、`desktop/cross-platform/src/`、`capabilities/`、`tauri.conf.json`

## 结论

整体高度合规：thin `main.rs`、全部逻辑在 `lib.rs`、`#[cfg_attr(mobile, tauri::mobile_entry_point)]` 已就位、`[lib]` 三种 crate-type 齐全、所有前端 `invoke()` 均在 `generate_handler!` 注册、错误以 `Result<T, String>` 返回、状态用单一 `Mutex`。

本次修复 2 项：

| #   | 问题                                                                        | skill 规则                         | 处置                                                   |
| --- | --------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| 1   | `capabilities/default.json` 同时声明 `core:default` 与 `core:event:default` | 「最小权限 / 避免 silent failure」 | `core:default` 已包含 `core:event:default`，移除冗余项 |
| 2   | `read_file_bytes` / `read_frames_batch` 为同步 command，阻塞 main thread    | 「Never block the main thread」    | 改为 `async` + `spawn_blocking`                        |

## 逐项核对

### ✅ 项目结构（skill「Project Structure」）

- `src-tauri/src/main.rs` 为 thin passthrough，仅 `kotori_pet_lib::run()`，含 `windows_subsystem = "windows"`。
- 所有应用逻辑（窗口透明、事件服务器、文件监听、状态聚合、命令注册）位于 `lib.rs::run()`。
- `pub fn run()` 带 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` — 移动端入口已就绪。

### ✅ `[lib]` 配置（skill「Cargo.toml」）

```toml
[lib]
name = "kotori_pet_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

三种 crate-type 齐全，满足跨平台（含移动端）编译要求。

### ✅ 命令注册（skill「IPC failures from unregistered commands」）

`lib.rs` 的 `generate_handler!` 注册 8 个命令：

```
get_config · run_applescript · quit_app · purge_all_sessions
read_file_bytes · read_frames_batch · cursor_in_window · js_log
```

前端 `invoke()` 调用点（`src/main.js`、`src/animator.js`）全部命中已注册命令，无「Command not found」风险。

### ✅ 错误处理（skill「Error Handling Pattern」）

- `run_applescript`、`purge_all_sessions`、`read_file_bytes`、`read_frames_batch`、`cursor_in_window` 均返回 `Result<T, String>`。
- `get_config` 返回 `FrontendConfig`（只读快照，无失败路径，合理）。
- `quit_app` / `js_log` 为 fire-and-forget，无需 Result。

### ✅ 状态管理（skill「State Management Pattern」）

- `ActivityAggregator` 用单一 `Mutex<Inner>` 承载全部可变状态（`activities` + `aggregated`），文档明确说明这是为消除死锁。
- 经 `app.manage(session_mgr.clone())` / `app.manage(config)` 注入，命令侧用 `State<'_, Arc<ActivityAggregator>>` / `State<'_, PetConfig>` 取用，类型与 `.manage()` 一致，无 state panic 风险。

### ✅ 前端 IPC 入口（skill「Step 2: Call from Frontend」）

通过 `withGlobalTauri: true` 暴露 `window.__TAURI__`，使用 `window.__TAURI__.core.invoke` / `window.__TAURI__.event.listen` —— 即 v2 的 `@tauri-apps/api/core` 等价路径，非 v1 的 `@tauri-apps/api/tauri`。

### ✅ 事件推送（skill「Event Emission Pattern」）

- Rust 侧 `app_handle.emit("state-change", &change)`（`lib.rs`），用 `tauri::Emitter`。
- JS 侧 `listen("state-change", ...)`（`main.js`）。
- 权限经 `core:default` 授予（见下）。

### ✅ 异步命令与借用类型（skill「Never use borrowed types in async commands」）

`run_applescript`（`async fn ... (script: String)`）、改造后的 `read_file_bytes` / `read_frames_batch` 均使用 owned 类型（`String` / `Vec<String>`），无 `&str` 跨 await。

### ✅ 窗口 API（skill「Window Access Pattern」）

- 使用 `app.get_webview_window("main")`（v2 API），非 v1 的 `get_window()`。
- 前端用 `getCurrentWindow()`（`@tauri-apps/api/window` 的 v2 形态）。

### ✅ 安全 / Capability（skill「Step 3: Add Required Permissions」）

`tauri.conf.json` 声明 `security.capabilities: ["default"]`，`capabilities/default.json` 列出：

```
core:default
core:window:allow-start-dragging
core:window:allow-set-position
core:window:allow-set-size
core:window:allow-set-ignore-cursor-events
```

四个 `core:window:*` 细粒度权限分别对应前端真实调用：`startDragging()` / `setPosition()` / `setSize()` / `setIgnoreCursorEvents()`（见 `src/main.js`）。无 `shell:allow-execute`，符合「最小权限」。

> 历史说明：`Cargo.toml` 注释记录了曾注册但从未授权的 `tauri-plugin-shell` 已被移除 —— 与 skill「Plugin installed but permission not in capability → silent failure」的告诫一致。

### ✅ CSP 与 asset 协议（skill「Configuration Reference」）

```json
"csp": "default-src 'self'; img-src asset: blob: https://asset.localhost data:; style-src 'self' 'unsafe-inline'"
```

- `img-src` 放行 `asset:` / `asset.localhost`（v2 asset 协议）与 `blob:`（后端读字节→前端构造 blob URL，绕过 WKWebView 画布污染）。
- `assetProtocol.scope.allow: ["**/*"]` 与 Rust 侧 `validate_path_in_frames` 形成纵深防御：协议层放行后，IPC 读字节仍校验落在 `frames_dir` 内。

### ✅ 路径处理（skill「Never hardcode paths」）

`config.rs` 用 `std::env::current_exe()` + 向上探测仓库根（`desktop/cross-platform` 地标），不硬编码绝对路径；`~` 展开、相对路径按 base 解析，Windows 读 `USERPROFILE`/`HOMEDRIVE+HOMEPATH`。

## 本次修复详情

### 1. capabilities 去冗余

**改动**：移除 `core:event:default`，更新 `description` 说明原因。

**依据**：`core:default` 是各核心模块 default 权限的聚合，已包含 `core:event:default`（`allow-listen` / `allow-emit` / `allow-emit-to` / `allow-once` / `allow-unlist`）。重复声明虽不致错，但会让读者误以为 event 权限「额外」开启，违背项目一贯的最小权限叙事。JS 侧 `listen("state-change")` 不受影响（权限仍由 `core:default` 授予）。

参考：[Tauri Core Permissions](https://v2.tauri.app/reference/acl/core-permissions/)。

### 2. 阻塞文件读取移出主线程

**改动**：`read_file_bytes` 与 `read_frames_batch` 由同步 `fn` 改为 `async fn`，I/O 包进 `tauri::async_runtime::spawn_blocking`。

**依据**：skill 明列「Never block the main thread」。同步 `#[tauri::command]` 在 webview 主线程执行；`read_frames_batch` 启动期会串行读取 55+ 帧做 alpha-mask 计算，同步执行会卡住主线程。改造后：

- `async` 把命令调度到 Tauri 异步运行时，不再占主线程；
- `spawn_blocking` 把真正的 `std::fs::read` 阻塞系统调用放到专用阻塞线程池，也不占用异步 worker。

前端早已 `await invoke(...)`，调用契约不变（返回类型相同），无需改 JS。

## 未改动但需注意的项

| 项                                     | 现状               | 说明                                                                                                                                                                                 |
| -------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 移动端目标                             | 仅桌面             | `run()` 带 mobile 入口、`[lib]` 就绪，但无 Android/iOS target / capability。skill 提示移动端构建前需 `rustup target add ...`；当前产品定位为桌面宠物，移动端为「预留」而非「支持」。 |
| `macOSPrivateApi` / `objc` 依赖        | macOS 专用透明窗口 | `#[cfg(target_os = "macos")]` 隔离，不影响其他平台。                                                                                                                                 |
| `core:default` 内含的 webview 默认权限 | 接受               | 桌面应用常见取舍；如需更严格，可改为显式列举 `core:webview:*`。                                                                                                                      |

## 复核命令

```bash
cd desktop/cross-platform/src-tauri
cargo check        # 编译通过
cargo clippy       # 无 warning
cargo test         # 8 个单测通过（config / aggregator）
cargo fmt --check  # 格式合规
```
