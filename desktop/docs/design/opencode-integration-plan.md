# OpenCode 集成计划

## Context

Kotori Pet 已通过 shell 脚本 + Python hooks 实现了对 Claude Code 和 Codex 的完整集成。预研阶段已完成 OpenCode 的事件映射分析（`opencode-plugin.ts`），但该插件仅有 console.log 调试输出，未接入宠物后端。本次任务将 OpenCode 插件升级为生产版本，与 Claude Code/Codex 保持完全一致的事件处理流程。

**核心差异**：Claude Code/Codex 通过 stdin JSON → Python 脚本 → Unix socket；OpenCode 通过 JS/TS 模块在进程内运行。但最终都写入相同格式的 session 文件 + 推送相同格式的 socket payload，Rust 后端无需任何修改。

---

## 修改概览

### 1. 将插件源码移至 `desktop/cross-platform/hooks/opencode-plugin.ts` — 生产版插件

> **注意**：插件源码从 `docs/design/` 迁移到 `hooks/` 目录，与 `pet-hook.sh`、`scripts/` 平级，保持 hook 相关代码聚合。`docs/design/` 中仅保留设计文档。

在现有调试版文件基础上，增加：

- **Config 加载**：读取同伴文件 `~/.config/opencode/plugins/.kotori-pet-config-dir`（由 setup-hooks.sh 写入）获取 `desktop/cross-platform/` 绝对路径，然后加载 `config.json` 获取 `state_map`、`sessions_dir`、`socket_path`、`terminal_events`
  - 加入健壮性校验：`existsSync(configDir)` 和 `existsSync(configPath)` 检查，路径无效时 `console.error` 并静默返回，不崩溃
- **异步写入 session 文件**：使用 `fs.promises.writeFile(.tmp)` + `fs.promises.rename(.tmp, target)`（POSIX 原子），payload 格式与 `common.py` 完全一致：
  ```json
  {
    "petId": "kotori-minami",
    "state": "running",
    "dialogue": "...",
    "event": "PreToolUse",
    "source": "opencode",
    "session_id": "...",
    "updatedAt": "<ISO-8601>",
    "isTerminal": false,
    "context": { "cwd": "...", "tool_name": "..." }
  }
  ```
  - `source` 固定为 `"opencode"`（与 Claude Code 的 `"claude-code"`、Codex 的 `"codex"` 对应）
  - `updatedAt` 使用 `new Date().toISOString()`（生成 `...Z` 格式），Rust 后端的 `chrono::DateTime::parse_from_rfc3339()` 兼容 `...Z` 和 `...+00:00` 两种 ISO 8601 表示
  - `context` 字段：**必须与 `common.py` 保持一致**，使用 `{ cwd, tool_name }`（OpenCode 插件的 `directory` 参数即为工作目录，直接作为 `cwd` 的值）
  - **使用异步 I/O**：OpenCode 插件运行在主进程内（Bun 运行时），同步 `writeFileSync` / `renameSync` 会阻塞事件循环。高频工具调用场景下可能造成可感知卡顿。改用 `fs.promises.*` 异步版本
- **Unix socket 推送**：使用 `node:net` 的 `connect()`，每次事件新建连接（与 Python hooks 行为一致），100ms 超时，失败静默
  - **Fire-and-forget**：**不 await socket push**。OpenCode 插件在主进程内运行（非独立进程），await socket push 意味着每个事件处理都被阻塞到 socket 操作完成。当宠物未启动时，100ms 超时会累积为可感知延迟。将 socket push 放入 `setTimeout(cb, 0)` 脱离当前 microtask，或直接调用不 await
  - 在回调中调用 `socket.destroy()` 确保连接不泄漏
- **事件映射**：复用已有的 `OPENCODE_TO_PET` 映射表（dot.case → PascalCase）和 state resolution 逻辑
  - **session_id 提取**：OpenCode 的 tool hook 第一个参数直接包含 `sessionID`（大写 D）：`input.sessionID`；事件型 hook 的 session ID 位于 `event.properties.sessionID`。无需多字段 fallback 链
    - **常见陷阱**：字段名是 `sessionID`（大写 D），不是 `sessionId`（小写 d），JS 区分大小写，写错会导致永远匹配不到
    - **事件 ID vs 会话 ID**：`event.id` 是事件 ID（`evt_xxx` 格式），不是会话 ID（`ses_xxx` 格式），不可用作 session_id
- **UserPromptSubmit 缺失**：OpenCode 没有 `message.send` 事件（消息类事件仅有 `message.updated`、`message.removed`、`message.part.updated`、`message.part.removed`），也没有任何事件能可靠地表示"用户提交了 prompt"。**不映射 `UserPromptSubmit`**。用户发送消息后，宠物会从 `SessionStart`/`waving` 状态过渡到第一次 `PreToolUse`/`running`，中间有短暂 `waving` 状态。这与 Claude Code/Codex 的行为有细微差异，但属于 OpenCode API 限制
- **错误隔离**：所有逻辑包裹在 try/catch 中，插件异常不影响 OpenCode 运行
- **多会话隔离**：OpenCode 支持多会话（`session.created` 可触发多次）。每次事件使用独立的 `session_id` 构建文件路径（`<sessions_dir>/<session_id>.json`），天然隔离。Socket 推送每次新建连接，无需排队

### 2. 修改 `desktop/cross-platform/setup-hooks.sh` — 增加 OpenCode 部署

> **注意**：当前 `setup-hooks.sh` 是 bash 包装器 + 内联 Python 脚本结构。OpenCode 部署逻辑应添加到**内联 Python 代码**中，与现有的通用 `setup_platform()` 函数并列（`setup_platform()` 是 Claude Code/Codex 共用的通用函数，OpenCode 的部署方式不同——复制文件而非注册 hook 条目——因此需要独立的 `setup_opencode()` 函数）。

在内联 Python 代码中增加 `setup_opencode()` 函数：

1. 从 config 读取 `hooks.opencode_plugins_dir`（默认 `~/.config/opencode/plugins/`，macOS/Linux XDG 路径；当前仅支持 macOS，暂不考虑 Windows 路径差异）
2. `os.makedirs(target_dir, exist_ok=True)` 创建目标目录
3. 使用 `shutil.copy2()` 复制 `desktop/cross-platform/hooks/opencode-plugin.ts` → `~/.config/opencode/plugins/pet-plugin.ts`（源文件名 `opencode-plugin.ts` 便于开发时识别，部署名为 `pet-plugin.ts` 避免与 OpenCode 自身命名冲突）
4. 写入同伴文件 `~/.config/opencode/plugins/.kotori-pet-config-dir`，内容为 `PLATFORM_DIR` 的绝对路径
5. 在主流程末尾调用 `setup_opencode()`，确保输出包含 "✓ OpenCode 部署成功"

### 3. 修改 `desktop/cross-platform/config.example.json` — 增加 OpenCode 配置和 QuestionAsked 状态

在 `hooks` 对象中增加：
```json
"opencode_plugins_dir": "~/.config/opencode/plugins"
```

在 `state_map` 中增加（与插件 `STATE_MAP` 中的 `QuestionAsked` 对应，dialogue 保持与现有中文风格一致）：
```json
"QuestionAsked": { "state": "waiting", "dialogue": "需要你的选择～" }
```

> **注意**：当前 `config.example.json` 缺少 `QuestionAsked` 条目。调试版插件用硬编码 `STATE_MAP` 覆盖了这个问题，但生产版改为从 config 加载后，缺少此条目会导致提问时宠物无反应（fallback 到 `{state: "idle", dialogue: ""}`）。

### 4. 更新文档

| 文件 | 变更 |
|---|---|
| `README.md` | 描述中加入 OpenCode |
| `AGENTS.md` | 描述加入 OpenCode |
| `desktop/AGENTS.md` | 同上 |
| `desktop/docs/agent-hooks/README.md` | 三平台对比表 OpenCode 行改为"已实现" |
| `desktop/docs/agent-hooks/opencode.md` | 新增"Production Integration"段落 |
| `desktop/docs/design/opencode-plugin.md` | 更新状态为生产版，更新架构图和部署方式 |
| Rust 后端 | 无需修改（source-agnostic 设计，`source` 字段仅存储不用作行为判断） |

### 5. 清理遗留文件

- 新插件实现并**测试通过后**再删除 `desktop/docs/design/opencode-plugin.ts`（保留调试版作为参考）
- 保留 `desktop/docs/design/opencode-plugin.md`（设计文档）

---

## 验证方式

1. `cd desktop/cross-platform && ./setup-hooks.sh` — 确认输出包含 OpenCode 部署成功
2. 确认 `~/.config/opencode/plugins/pet-plugin.ts` 和 `.kotori-pet-config-dir` 文件已创建
3. 启动宠物应用 (`./build-and-run.sh`)
4. 启动 OpenCode TUI，发送 prompt
5. 观察宠物状态变化：
   - 会话创建时进入 `waving`（SessionStart）
   - 首次工具调用时进入 `running`（PreToolUse）
   - **已知差异**：由于 OpenCode 无 `UserPromptSubmit` 事件，用户发送消息到首次工具调用之间，宠物保持 `waving` 状态而非 `running`
   - 被提问时进入 `waiting`（QuestionAsked）
   - 会话结束时进入 `jumping`（Stop）或 `failed`（StopFailure）
6. 检查 `runtime/sessions/` 下生成正确格式的 session 文件
7. 检查 `RUST_LOG=debug` 日志确认 socket payload 被正确解析

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 无 `UserPromptSubmit` 映射 | OpenCode API 无此事件，用户发消息后宠物短暂保持 `waving` 直到首次 `PreToolUse` |
| Windows 原子写 | `rename()` 在 POSIX 上原子但 Windows 上非原子；当前仅支持 macOS，暂无影响 |
| 配置同伴文件失效 | 移动 repo 目录后 `.kotori-pet-config-dir` 中路径失效，插件会静默降级（仅 console.error） |
| 无自动卸载 | `setup-hooks.sh` 无 `--clean` 参数，卸载需手动删除 `~/.config/opencode/plugins/pet-plugin.ts` 和 `.kotori-pet-config-dir` |
| XDG 路径仅 macOS/Linux | `opencode_plugins_dir` 默认值为 XDG 路径，当前仅支持 macOS，Windows 支持需另行调整 |
