# Hook 脚本详解

## 文件

| 文件 | 用途 |
|---|---|
| `cross-platform/hooks/pet-claude-hook.sh` | Claude Code hook 入口（shell wrapper）|
| `cross-platform/hooks/pet-codex-hook.sh` | Codex hook 入口（shell wrapper）|
| `cross-platform/hooks/scripts/common.py` | 共享逻辑：配置加载、session 写入、socket 推送 |
| `cross-platform/hooks/scripts/claude_hook.py` | Claude Code 事件处理 |
| `cross-platform/hooks/scripts/codex_hook.py` | Codex 事件处理（含 EVENT_ALIASES + 调试日志）|

Shell 脚本仅做调用入口，所有逻辑在 `scripts/*.py` 中。两个 hook 共享 `common.py` 中约 120 行核心代码。

## 机制

两个 Python 入口脚本结构相似，都从 stdin JSON 解析事件并调用 `common.process_event()`：

**事件字段解析：**
- **Claude Code**: 直接读取 `hook_event_name` 字段
- **Codex**: 按优先级尝试多个字段名（`hook_event_name` → `event` → `codex_event_type`），并通过 `EVENT_ALIASES` 将 snake_case 转为 PascalCase（如 `stop_failure` → `StopFailure`）

**Session ID 解析：**
- **Claude Code**: 读取 `session_id`
- **Codex**: 按优先级尝试 `session_id` → `sessionId` → `conversation_id` → `thread_id`

所有配置（路径、映射、台词）从 `config.json` / `config.example.json` 读取，无硬编码。

## 执行流程

```
stdin JSON
  → 加载 config.json (找不到则降级 config.example.json)
  → 自动检测 repo 根目录 (从脚本位置向上推导)
  → 解析事件名 + session_id + tool_name
  → 映射 event → (state, dialogue)
  → 原子写入 sessions/{session_id}.json
  → 推送 Unix socket (best-effort)
  → terminal 事件: 延迟删除文件 (threading.Timer)
```

## 路径自动检测

```
hooks/scripts/claude_hook.py   → PLATFORM_DIR = scripts 的父父目录 (cross-platform/)
PLATFORM_DIR.parent.parent      → REPO_ROOT (desktop/ 的父目录)

null 值自动拼接:
  pet_base_dir → REPO_ROOT
  frames_dir   → REPO_ROOT/{pet_id}/frames
  sessions_dir → REPO_ROOT/desktop/cross-platform/runtime/sessions
```

## 事件 → 状态映射

配置文件中的 `state_map` 和 `tool_dialogue` 定义所有映射，用户可直接编辑。

| 事件 | 动画状态 | 对话台词 | 类型 |
|---|---|---|---|
| `SessionStart` | waving | "嗨！小鸟来啦～" | 普通 |
| `UserPromptSubmit` | running | "收到！开始工作～" | 普通 |
| `PreToolUse` | running | "执行中..." | 普通 |
| `PostToolUse` | running | "处理中..." | 普通 |
| `Stop` | jumping | "搞定啦！✨" | 延迟删除 (2s) |
| `StopFailure` | failed | "呜...出了点问题" | terminal (3s) |
| `Notification` | waving | "注意哦～" | 普通 |
| `PermissionRequest` | waiting | "需要你的授权～" | 普通 |
| `SubagentStop` | idle | "" | 普通 |
| `PreCompact` | waiting | "整理一下记忆..." | 普通 |
| `SessionEnd` | waving | "下次见！♪" | 立即删除 |

`terminal_events` 配置项定义哪些事件是 terminal（当前默认: `["StopFailure", "SessionEnd"]`）。

## Session 文件格式

路径: `desktop/cross-platform/runtime/sessions/{session_id}.json`

```json
{
  "petId": "kotori-minami",
  "state": "running",
  "dialogue": "执行中...",
  "event": "PreToolUse",
  "source": "claude-code",
  "session_id": "f2f5b758-...",
  "updatedAt": "2026-06-07T10:09:16.998Z",
  "isTerminal": false,
  "context": {
    "cwd": "/Users/user/project",
    "tool_name": "Bash"
  }
}
```

## 会话生命周期

```
SessionStart → 创建 session 文件
    ↓
工作期间 → 持续更新 (PreToolUse / PostToolUse / ...)
    ↓
Stop → 写入 jumping 状态，2 秒后异步删除
StopFailure → 写入 failed 状态，3 秒后异步删除
SessionEnd → 立即删除 session 文件
```

**原子写入**: 先写 `.tmp`，再 `os.replace()` 重命名，防止读到不完整数据。

**延迟删除**: 使用 `threading.Timer` 而非 shell 子进程，避免路径中特殊字符导致的 shell 注入风险。

## 配置集成脚本

`setup-hooks.sh` 从 config 读取 hook 路径和 settings 路径，自动：
1. 清理旧版本 hook 条目（包括 `desktop/mac/hooks/` 的旧路径）
2. 为每个事件添加新的 hook
3. 写回 settings 文件

配置项：
```json
"hooks": {
  "claude_code_settings": "~/.claude/settings.json",
  "codex_hooks": "~/.Codex/hooks.json"
}
```

清理的旧路径：
- `kotori-desktop-pet/hooks/pet-claude-hook.sh`
- `kotori-desktop-pet/hooks/pet-codex-hook.sh`
- `desktop/mac/hooks/pet-claude-hook.sh`
- `desktop/mac/hooks/pet-codex-hook.sh`

## 调试

Codex hook 会将每次事件的摘要写入 `/tmp/kotori-pet-codex-hook.log`，格式：

```json
{"time": "...", "raw_event": "stop", "event": "Stop", "session_id": "...", "state": "jumping", "dialogue": "搞定啦！✨"}
```

## 支持新平台

复制 `pet-claude-hook.sh`，修改事件字段名和别名映射即可。所有平台共享 config.json。
