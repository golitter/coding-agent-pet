# OpenCode 宠物插件 — 设计文档

## 背景

Kotori Pet 已通过 Hooks 系统支持 Claude Code 和 OpenAI Codex 的生命周期事件驱动宠物动画。OpenCode 采用不同的插件架构——JS/TS 模块在进程内运行，而非 Claude Code/Codex 的"命令行脚本 + stdin JSON"模式。

本插件作为 OpenCode 的适配层，将 OpenCode 的事件体系归约到与 Claude Code/Codex 相同的 PascalCase 事件名，最终查同一张 `state_map`，确保三个平台的宠物表现一致。

## 插件文件

| 文件 | 说明 |
|---|---|
| [opencode-plugin.ts](opencode-plugin.ts) | 插件源码（独立调试版） |
| `~/.config/opencode/plugins/pet-plugin.ts` | 运行时位置（全局） |

部署：

```bash
cp desktop/docs/design/opencode-plugin.ts ~/.config/opencode/plugins/pet-plugin.ts
```

## 架构

```
OpenCode 事件
    │
    ├── 拦截型 (tool.execute.before/after)  ─┐
    │                                         │
    └── 事件型 (event handler)             ──┤
                                              ▼
                                    OPENCODE_TO_PET 映射
                                    dot.case → PascalCase
                                              │
                                              ▼
                                    resolveState() 查表
                                    STATE_MAP → { state, dialogue }
                                              │
                                              ▼
                                    console.log 输出（调试版）
                                    未来：写 session 文件 + 推 Unix socket
```

## 事件映射

### 映射表 `OPENCODE_TO_PET`

| OpenCode 事件 (dot.case) | → PascalCase | Hook 类型 | 宠物 state | 对话 |
|---|---|---|---|---|
| `session.created` | `SessionStart` | 事件型 | `waving` | 嗨！小鸟来啦～ |
| `session.idle` | `Stop` | 事件型 | `jumping` | 搞定啦！✨ |
| `session.error` | `StopFailure` | 事件型 | `failed` | 呜...出了点问题 |
| `session.deleted` | `SessionEnd` | 事件型 | `waving` | 下次见！♪ |
| `session.compacted` | `PreCompact` | 事件型 | `waiting` | 整理一下记忆... |
| `permission.asked` | `PermissionRequest` | 事件型 | `waiting` | 需要你的授权～ |
| `tool.execute.before` | `PreToolUse` | 拦截型 | `running` | 执行中... |
| `tool.execute.after` | `PostToolUse` | 拦截型 | `running` | 处理中... |
| `question` 工具 (before) | `QuestionAsked` | 拦截型 | `waiting` | 需要你的选择～ |

### 特殊处理

- **`PostToolUse`**：硬编码为 `running` + `"处理中..."`，与 `common.py` 保持一致
- **`question` 工具**：`tool.execute.before` 中拦截 `input.tool === "question"` 映射为 `QuestionAsked`；`tool.execute.after` 中跳过
- **Tier 3 事件**：不在映射表中的 `event.type` 直接忽略（`file.*`、`message.*`、`lsp.*`、`tui.*`、`command.*`、`todo.*`、`installation.*`、`server.*`、`shell.*`）

### 三平台归约对比

```
               Claude Code          Codex                OpenCode
               ───────────          ─────                ─────────
事件名格式     PascalCase           snake_case            dot.case
归约层         无（直接读）          EVENT_ALIASES         OPENCODE_TO_PET
归约后         ────────────→ PascalCase ←────────────────────────
                         查同一张 state_map
```

## Terminal 事件

与 `config.json` 的 `terminal_events` 保持一致：

- `StopFailure` — AI 执行失败，立即删除 session 文件
- `SessionEnd` — 会话结束，立即删除 session 文件

## 调试输出格式

每个事件触发时输出一行 JSON：

```json
{
  "ts": "2026-06-11T12:34:56.789Z",
  "plugin": "kotori-pet",
  "source": "opencode",
  "rawEvent": "session.idle",
  "pascalEvent": "Stop",
  "state": "jumping",
  "dialogue": "搞定啦！✨",
  "sessionId": "abc123...",
  "isTerminal": false
}
```

插件初始化时输出：

```json
{
  "ts": "2026-06-11T12:34:56.789Z",
  "plugin": "kotori-pet",
  "msg": "initialized",
  "project": "pet",
  "directory": "/path/to/project",
  "worktree": "/path/to/worktree"
}
```

## 与现有系统的关系

当前版本为**独立调试版**，只做事件捕获 + 日志输出，不连接宠物后端。未来集成时需增加：

1. **读 `config.json`** — 复用 `state_map`、`terminal_events`、`socket_path`、`sessions_dir`
2. **写 session 文件** — 原子写入（`.tmp` + `rename`），格式与 Python hooks 一致
3. **推 Unix socket** — 连接 `/tmp/kotori-pet.sock`，发送相同 payload

这三个步骤加上后，插件即成为与 `claude_hook.py` / `codex_hook.py` 等价的事件源。

## 测试方法

1. 部署插件到全局目录（见上方）
2. 启动 OpenCode TUI：`opencode`
3. 输入任意 prompt，观察 console 输出
4. 验证事件映射链路：`rawEvent → pascalEvent → state → dialogue`

## 参考

| 资源 | 链接 |
|---|---|
| OpenCode 官方插件文档 | https://opencode.ai/docs/zh-cn/plugins/ |
| OpenCode 插件系统详解（知乎） | https://zhuanlan.zhihu.com/p/2027144829352583703 |
| 本项目 Claude Code hooks 文档 | [agent-hooks/claude-code.md](../agent-hooks/claude-code.md) |
| 本项目 Codex hooks 文档 | [agent-hooks/codex.md](../agent-hooks/codex.md) |
| 本项目 OpenCode hooks 参考 | [agent-hooks/opencode.md](../agent-hooks/opencode.md) |
