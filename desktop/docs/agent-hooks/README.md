# Agent Hooks — Claude Code & Codex & OpenCode 驱动虚拟宠物的方式

本目录详细描述 Claude Code、OpenAI Codex 和 OpenCode 如何通过各自的 Hooks / 插件系统驱动 Kotori 虚拟宠物的渲染。

Claude Code 和 Codex 的事件机制不同，但宠物端通过 `common.py` 统一处理，最终效果一致。OpenCode 采用不同的插件架构（JS/TS 进程内模块），通过 `opencode-plugin.ts` 实现宠物集成。

## 文件

| 文件 | 内容 |
|---|---|
| [events.md](events.md) | 所有 Hook 事件类型 + 平台行为对照表（速查） |
| [claude-code.md](claude-code.md) | Claude Code 如何通过 Hooks 触发宠物状态变化 |
| [codex.md](codex.md) | OpenAI Codex 如何通过 Hooks 触发宠物状态变化 |
| [opencode.md](opencode.md) | OpenCode 插件系统参考（事件、Hook API、潜在集成方案） |

## 三个平台的对比

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| **机制** | 命令行脚本 + stdin JSON | 命令行脚本 + stdin JSON | JS/TS 插件模块，进程内运行 |
| **配置文件** | `~/.claude/settings.json` | `~/.codex/hooks.json` 或 `config.toml` | `.opencode/plugins/` 目录或 `opencode.json` |
| **Hook 入口** | `pet-hook.sh claude-code` → `claude_hook.py` | `pet-hook.sh codex` → `codex_hook.py` | `opencode-plugin.ts` → 导出 Plugin 函数 |
| **事件字段名** | `hook_event_name` (PascalCase) | `hook_event_name` / `event` / `codex_event_type` (snake_case) | 事件名即对象键名（如 `session.idle`） |
| **注册事件数** | 11 个 | 9 个 | 20+ 个事件类别 |
| **独有事件** | `PreCompact`, `SessionEnd` | — | `session.compacted`, 自定义工具, `shell.env` |
| **信任机制** | 启动时快照，修改需在 `/hooks` 审查 | 非托管 hook 需 review & trust，按 hash 校验 | — |
| **输出格式** | exit 0 静默；exit 2 阻断 | 期望 stdout 返回 `{}` | 函数参数 `(input, output)`，throw 阻断 |
| **自定义工具** | ❌ | ❌ | ✅ `tool()` API |
| **宠物集成** | ✅ 已实现 | ✅ 已实现 | ✅ 已实现（详见 opencode.md） |

## 共享的处理流程

两个 hook 脚本最终都调用 `common.py:process_event()`，OpenCode 插件在 TS 中实现等价逻辑，走同一条管线：

```
stdin JSON
  → 解析事件名 + session_id + tool_name
  → config.json state_map 查表 → 得到 {state, dialogue}
  （OpenCode 插件直接读取 config.json，逻辑等价）
  → 原子写入 sessions/{session_id}.json
  → 推送 Unix socket /tmp/kotori-pet.sock
  → 后端处理 isTerminal:
       Stop → 2s 延迟删除（让"搞定啦"播完，期间收到新事件则取消）
       StopFailure / SessionEnd → 立即删除 session 文件
```

详见各平台的独立文档。

## 已知局限

- **用户中断后宠物卡在 running 长达 1h**：两个平台都没有"用户中断"hook（Claude Code Issue [#9516](https://github.com/anthropics/claude-code/issues/9516)、Codex 0.133.0 同），导致中断后 session 文件不会被刷新，直到 `stale_timeout_sec`（默认 1h）后被自动清理。详细分析与未来修复方向见 [events.md "注意"段](events.md#注意)。
