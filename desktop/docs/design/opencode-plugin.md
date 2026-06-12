# OpenCode 宠物插件 — 设计文档

## 状态

**已实现生产版本**。生产版插件位于 `desktop/cross-platform/hooks/opencode-plugin.ts`，包含完整的 session 文件写入 + Unix socket 推送功能。本文档中的调试版源码保留在 `opencode-plugin.ts`（本目录）作为参考。

## 背景

Kotori Pet 已通过 Hooks 系统支持 Claude Code 和 OpenAI Codex 的生命周期事件驱动宠物动画。OpenCode 采用不同的插件架构——JS/TS 模块在进程内运行，而非 Claude Code/Codex 的"命令行脚本 + stdin JSON"模式。

本插件作为 OpenCode 的适配层，将 OpenCode 的事件体系归约到与 Claude Code/Codex 相同的 PascalCase 事件名，最终查同一张 `state_map`，确保三个平台的宠物表现一致。

## 插件文件

| 文件 | 说明 |
|---|---|
| [opencode-plugin.ts](opencode-plugin.ts) | 调试版源码（console.log 输出，保留参考） |
| [../../cross-platform/hooks/opencode-plugin.ts](../../cross-platform/hooks/opencode-plugin.ts) | **生产版源码**（session 文件 + socket 推送） |
| `~/.config/opencode/plugins/pet-plugin.ts` | 运行时位置（全局，由 setup-hooks.sh 自动部署） |

部署（自动）：

```bash
cd desktop/cross-platform && ./setup-hooks.sh
# 自动复制 → ~/.config/opencode/plugins/pet-plugin.ts
# 自动写入 .kotori-pet-config-dir
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
                                    config.json state_map → { state, dialogue }
                                              │
                                              ▼
                                    异步写 session 文件（原子 rename）
                                    + Unix socket 推送（fire-and-forget）
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

调试版每个事件触发时输出一行 JSON（生产版不再输出调试日志，改为写 session 文件 + 推 socket）：

```json
{
  "ts": "2026-06-11T12:34:56.789Z",
  "plugin": "kotori-pet",
  "source": "opencode",
  "rawEvent": "session.idle",
  "pascalEvent": "Stop",
  "state": "jumping",
  "dialogue": "搞定啦！✨",
  "sessionId": "ses_149004ab5ffe...",
  "isTerminal": false
}
```

## Session ID 提取

OpenCode 的两种 hook 提供 session ID 的方式不同：

| Hook 类型 | session ID 来源 | 字段路径 |
|---|---|---|
| `tool.execute.before` | 第一个参数对象 | `input.sessionID`（大写 D） |
| `tool.execute.after` | 第一个参数对象 | `input.sessionID`（大写 D） |
| `event` handler | 事件对象的 properties | `event.properties.sessionID` |

> **常见陷阱**：字段名是 `sessionID`（大写 D），不是 `sessionId`（小写 d）。JS 区分大小写，写错会导致永远匹配不到，fallback 到 `"unknown"`。
> **事件 ID vs 会话 ID**：事件对象有 `event.id`（格式 `evt_xxx`），这是事件 ID 不是会话 ID。会话 ID 格式为 `ses_xxx`，位于 `event.properties.sessionID`。

## 与现有系统的关系

生产版插件已实现完整集成：

1. **读 `config.json`** — 通过同伴文件 `~/.config/opencode/plugins/.kotori-pet-config-dir` 定位 platform dir，加载 `state_map`、`terminal_events`、`socket_path`、`sessions_dir`
2. **Repo Root 检测** — `detectRepoRoot()` 从 platform dir 推导仓库根目录：若路径以 `desktop/cross-platform` 结尾则向上两级，否则向上一级。返回值作为 `resolvePath()` 的基准目录
3. **路径解析** — `resolvePath()` 以 repo root 为基准：相对路径基于 repo root 展开，fallback 路径为 `{repoRoot}/desktop/cross-platform/runtime/sessions`，与 Rust 后端 `config.rs` 的 `pet_base_dir` 逻辑一致
4. **异步写 session 文件** — `fs.promises.writeFile(.tmp)` + `fs.promises.rename(.tmp, target)` 原子写入，格式与 Python hooks 一致
5. **推 Unix socket** — `node:net.createConnection()`，fire-and-forget，100ms 超时

插件已成为与 `claude_hook.py` / `codex_hook.py` 等价的事件源。Rust 后端无需任何修改（source-agnostic 设计）。

## 测试方法

1. 运行 `cd desktop/cross-platform && ./setup-hooks.sh` — 确认输出包含 OpenCode 部署成功
2. 确认 `~/.config/opencode/plugins/pet-plugin.ts` 和 `.kotori-pet-config-dir` 文件已创建
3. 启动宠物应用 (`./build-and-run.sh`)
4. 启动 OpenCode TUI，发送 prompt
5. 观察宠物状态变化：waving → running → jumping/failed

## 参考

| 资源 | 链接 |
|---|---|
| OpenCode 官方插件文档 | https://opencode.ai/docs/zh-cn/plugins/ |
| OpenCode 插件系统详解（知乎） | https://zhuanlan.zhihu.com/p/2027144829352583703 |
| 本项目 Claude Code hooks 文档 | [agent-hooks/claude-code.md](../agent-hooks/claude-code.md) |
| 本项目 Codex hooks 文档 | [agent-hooks/codex.md](../agent-hooks/codex.md) |
| 本项目 OpenCode hooks 参考 | [agent-hooks/opencode.md](../agent-hooks/opencode.md) |
