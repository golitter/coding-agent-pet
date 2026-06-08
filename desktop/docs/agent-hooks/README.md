# Agent Hooks — Claude Code & Codex 驱动虚拟宠物的方式

本目录详细描述 Claude Code 和 OpenAI Codex 如何通过各自的 Hooks 系统驱动 Kotori 虚拟宠物的渲染。

两个平台的事件机制不同，但宠物端通过 `common.py` 统一处理，最终效果一致。

## 文件

| 文件 | 内容 |
|---|---|
| [events.md](events.md) | 所有 Hook 事件类型 + 两个平台各自行为的对照表（速查） |
| [claude-code.md](claude-code.md) | Claude Code 如何通过 Hooks 触发宠物状态变化 |
| [codex.md](codex.md) | OpenAI Codex 如何通过 Hooks 触发宠物状态变化 |

## 两个平台的对比

| | Claude Code | Codex |
|---|---|---|
| **配置文件** | `~/.claude/settings.json` | `~/.codex/hooks.json` 或 `config.toml` |
| **Hook 入口** | `pet-claude-hook.sh` → `claude_hook.py` | `pet-codex-hook.sh` → `codex_hook.py` |
| **事件字段名** | `hook_event_name` (PascalCase) | `hook_event_name` / `event` / `codex_event_type` (snake_case) |
| **注册事件数** | 11 个 | 9 个 |
| **独有事件** | `PreCompact`, `SessionEnd` | — |
| **信任机制** | 启动时快照，修改需在 `/hooks` 审查 | 非托管 hook 需 review & trust，按 hash 校验 |
| **输出格式** | exit 0 静默；exit 2 阻断 | 期望 stdout 返回 `{}` |
| **调试日志** | — | `/tmp/kotori-pet-codex-hook.log` |

## 共享的处理流程

两个 hook 脚本最终都调用 `common.py:process_event()`，走同一条管线：

```
stdin JSON
  → 解析事件名 + session_id + tool_name
  → config.json state_map 查表 → 得到 {state, dialogue}
  → 原子写入 sessions/{session_id}.json
  → 推送 Unix socket /tmp/kotori-pet.sock
  → 后端处理 isTerminal:
       Stop → 2s 延迟删除（让"搞定啦"播完，期间收到新事件则取消）
       StopFailure / SessionEnd → 立即删除 session 文件
```

详见各平台的独立文档。
