---
name: ask-claudecode
description: "在 Codex 中直接调用本机 Claude Code CLI 作为子 agent，并默认开启 Claude Code 的全部工具与危险权限。用于用户要求调用 Claude Code、让 Claude Code 作为 agent 处理或审查任务、把任务交给 claudecode、记录 Claude Code session_id、减少 Codex 侧上下文/token 压力等场景。"
---

# Ask ClaudeCode

## 用途

使用这个 skill 时，Codex 通过一个很薄的 wrapper 启动本机 `claude -p`，把用户指定任务交给 Claude Code 执行。

这个 wrapper 不替代 Claude Code，也不处理工具调用细节；它只负责清洗 Claude Code 的最终 JSON，提取 Codex 真正需要的字段：

- `result`
- `session_id`
- `ok`

默认只输出这三个字段，避免把 Claude Code 的原始事件、usage、cost 等噪音带回 Codex。
如需调试，可用 `--raw-output` 保存 Claude Code 原始 JSON。

默认调用参数：

- `--dangerously-skip-permissions`
- `--output-format json`
- `--verbose`
- `--max-turns 256`

## 快速调用

```bash
python3 .agents/skills/ask-claudecode/scripts/ask_claudecode.py \
  "帮我检查当前项目并给出修改建议"
```

继续某个 Claude Code 会话：

```bash
python3 .agents/skills/ask-claudecode/scripts/ask_claudecode.py \
  --resume <claude_session_id> \
  "继续刚才的任务"
```

指定新的 Claude Code session id：

```bash
python3 .agents/skills/ask-claudecode/scripts/ask_claudecode.py \
  --session-id <uuid> \
  "用这个 session id 开始任务"
```

## Session 记录

每次调用结束后，Codex 必须从 Claude Code 的 JSON 输出中提取 `session_id`，并在给用户的回复里明确写出：

```text
Claude Code session_id: <id>
```

如果后续需要继续该 Claude Code 会话，使用：

```bash
python3 .agents/skills/ask-claudecode/scripts/ask_claudecode.py --resume <id> "..."
```

如果用户已经提供了一个要固定使用的 Claude Code session uuid，或者 Codex 已经为本次任务分配了固定 Claude Code 会话，则必须把它传给 Claude Code：

```bash
python3 .agents/skills/ask-claudecode/scripts/ask_claudecode.py \
  --session-id <session-uuid> \
  "..."
```

对应的底层 Claude Code 参数是：

```bash
claude -p "..." --session-id <session-uuid> --output-format json --verbose --dangerously-skip-permissions --max-turns 256
```

原则：

- 第一次需要绑定指定会话时，用 `--session-id <session-uuid>`。
- 已经拿到 Claude Code 返回的 `session_id`，后续继续同一会话时，用 `--resume <session_id>`。
- 不要在同一条命令里同时传 `--session-id` 和 `--resume`。
- 不要丢弃 session id；每次回复用户时都应带上最新的 `session_id`。

## Codex 使用流程

1. 用户要求调用 Claude Code 时，使用本 skill。
2. 用 `scripts/ask_claudecode.py` 调用 Claude Code。
3. wrapper 内部使用 `claude -p --output-format json --verbose --dangerously-skip-permissions --max-turns 256`。
4. 读取 wrapper 输出的精简 JSON。
5. 使用 `result` 作为 Claude Code 回答。
6. 读取 `session_id` 并报告给用户。

## 等待策略

Claude Code 一次对话可能运行很久。使用 `--output-format json` 时，Claude Code 通常只在任务结束后一次性输出最终 JSON，中途长时间没有 stdout 是正常现象。

调用后要耐心等待：

- 不要因为 30 秒或 1 分钟无输出就判断失败。
- 每隔一段时间轮询进程状态即可，不要重复启动新的 Claude Code。
- 适合给用户简短说明：“Claude Code 还在执行，JSON 模式下不会输出中间过程。”
- 只有在用户要求停止、进程明显异常、或等待时间已经不符合任务规模时，才考虑中断。

如果担心任务过长，可以在命令里主动加：

```bash
--max-turns <N>
```

但不要默认加很小的 `--max-turns`，否则 Claude Code 可能还没完成子任务就提前停止。

## Codex 沙箱注意事项

在 Codex 的默认 shell 沙箱里运行 `claude -p` 时，Claude Code 可能无法访问 API/DNS，表现为长时间无输出、反复重试，最终 JSON 中出现：

```text
API Error: Unable to connect to API (ENOTFOUND)
```

遇到这种情况，不要继续调整 prompt 或重复启动多个 Claude Code。应当将同一条 `claude -p` 命令以不受沙箱限制的方式重跑，并说明原因是 Claude Code 需要访问自己的 API。

判断依据：

- 本地终端同一条命令可以跑完，但 Codex shell 中卡住或返回 `ENOTFOUND`。
- Claude Code JSON 输出里出现 `api_retry` 事件，且 `duration_api_ms` 为 0。
- 最终 `result` 是 `API Error: Unable to connect to API (ENOTFOUND)`。

重跑时仍使用本 skill 的标准参数：

```bash
python3 .agents/skills/ask-claudecode/scripts/ask_claudecode.py "..."
```

## 常用参数

- `--session-id`：新建/指定 Claude Code session id。
- `--resume`：恢复已有 Claude Code session id。
- `--max-turns`：限制 Claude Code turns；默认建议使用 `256`，避免子 agent 任务过早停止。
- `--append-system-prompt`：追加系统提示。
- `--model`：指定 Claude 模型或别名。
- `--add-dir`：授权额外目录。
- `--raw-output PATH`：保存 Claude Code 原始 JSON 输出，方便调试。
- `--pretty`：用缩进格式输出精简 JSON。

默认不限制 Claude Code 工具，也不做权限拦截。不要默认添加 `--tools default`；当前推荐直接依赖 Claude Code 默认工具集，并用 `--dangerously-skip-permissions` 放开权限。
