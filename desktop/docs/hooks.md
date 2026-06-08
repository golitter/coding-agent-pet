# Hook 脚本详解

## 文件

| 文件 | 用途 |
|---|---|
| `cross-platform/hooks/pet-claude-hook.sh` | Claude Code 事件处理 |
| `cross-platform/hooks/pet-codex-hook.sh` | Codex 事件处理 |

## 机制

两个脚本结构相同，区别仅在事件字段名：
- **Claude Code**: 从 stdin JSON 的 `hook_event_name` 读取事件
- **Codex**: 从 stdin JSON 的 `event` 读取事件

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
  → terminal 事件: 异步延迟删除文件
```

## 路径自动检测

```
hooks/pet-claude-hook.sh   → PLATFORM_DIR = hooks 的父目录 (cross-platform/)
PLATFORM_DIR.parent.parent  → REPO_ROOT (desktop/ 的父目录)

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

## 支持新平台

复制 `pet-claude-hook.sh`，修改事件字段名即可。所有平台共享 config.json。
