# Claude Code Hooks → 虚拟宠物渲染

Claude Code 通过其 Hooks 系统在特定生命周期事件时，将 JSON 数据通过 stdin 传递给用户配置的命令行脚本。Kotori 虚拟宠物利用这一机制，监听 Claude Code 的工作状态并实时反映到桌面宠物的动画和对话中。

> **官方文档**: [Claude Code Hooks Reference](https://docs.anthropic.com/en/docs/claude-code/hooks)

---

## 一、配置注册

### 配置文件

Claude Code 的 hooks 配置写在 `~/.claude/settings.json` 中：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "command": "/path/to/desktop/cross-platform/hooks/pet-claude-hook.sh",
            "type": "command"
          }
        ]
      }
    ],
    "PreToolUse": [ ... ],
    "Stop": [ ... ]
  }
}
```

配置层级（优先级从低到高）：

1. Enterprise managed policy settings
2. `~/.claude/settings.json` — 用户级（宠物 hook 注册在这里）
3. `.claude/settings.json` — 项目级
4. `.claude/settings.local.json` — 本地项目级（不提交）

**注意**：宠物 hook 注册在用户级，这样所有项目都会触发宠物。

### 注册脚本 — setup-hooks.sh

`setup-hooks.sh` 自动完成配置，不需要手动编辑 settings.json：

```
1. 读取 config.json 获取 hook 脚本路径和 settings 路径
2. 清理旧版本 hook 条目（mac/旧目录）
3. 为 11 个事件逐一添加 hook 条目
4. 原子写入（.tmp + os.replace）防止配置文件损坏
```

### 注册的 11 个事件

| 事件 | 触发时机 | 宠物用途 |
|---|---|---|
| `SessionStart` | 启动或恢复会话 | 宠物挥手："嗨！小鸟来啦～" |
| `UserPromptSubmit` | 用户提交 prompt | 宠物奔跑："收到！开始工作～" |
| `PreToolUse` | Claude 调用工具之前 | 宠物奔跑："执行中..." |
| `PostToolUse` | 工具执行完成后 | 宠物奔跑："处理中..." |
| `Stop` | Claude 完成响应 | 宠物跳跃："搞定啦！✨" |
| `StopFailure` | Claude 执行失败 | 宠物失败："呜...出了点问题" |
| `Notification` | 发送通知时 | 宠物挥手："注意哦～" |
| `PermissionRequest` | 请求权限时 | 宠物等待："需要你的授权～" |
| `SubagentStop` | 子代理完成时 | 宠物回到 idle |
| `PreCompact` | 压缩上下文之前 | 宠物等待："整理一下记忆..." |
| `SessionEnd` | 会话结束时 | 宠物挥手："下次见！♪" |

**注意**：宠物 hook 不使用 `matcher` 字段，匹配所有工具调用，因为宠物的目的是反映整体工作状态，而非拦截特定工具。

---

## 二、Hook 输入格式

Claude Code 通过 stdin 传递 JSON，每个事件的字段略有不同。

### 通用字段（所有事件都有）

```json
{
  "session_id": "f2f5b758-abc123...",
  "cwd": "/Users/user/project",
  "hook_event_name": "PreToolUse"
}
```

### PreToolUse 额外字段

```json
{
  "session_id": "...",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01ABC...",
  "tool_input": {
    "command": "npm test"
  }
}
```

### UserPromptSubmit 额外字段

```json
{
  "session_id": "...",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "帮我重构这个模块"
}
```

### Stop / SubagentStop 额外字段

```json
{
  "session_id": "...",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "我已经完成了重构..."
}
```

### SessionEnd 额外字段

```json
{
  "session_id": "...",
  "hook_event_name": "SessionEnd",
  "reason": "prompt_input_exit"
}
```

`reason` 取值：`clear` | `logout` | `prompt_input_exit` | `other`

---

## 三、宠物 Hook 处理流程

### 入口：pet-claude-hook.sh → claude_hook.py

```
Claude Code 触发 hook
        │
        │ stdin JSON
        ▼
pet-claude-hook.sh
        │
        │ /usr/bin/python3 scripts/claude_hook.py
        ▼
claude_hook.py
        │
        │ 1. json.load(sys.stdin) 读取输入
        │ 2. 提取 hook_event_name, session_id, tool_name, cwd
        │ 3. 调用 common.process_event()
        ▼
common.process_event()
        │
        │ 4. load_config() 加载 config.json
        │ 5. state_map 查表 → {state, dialogue}
        │ 6. 写 session 文件 (原子写入)
        │ 7. 推送 Unix socket
        │ 8. terminal 事件: 延迟删除
        ▼
Tauri 渲染器 → 宠物动画更新
```

### Claude Code 特有的事件字段解析

```python
# claude_hook.py 中的字段提取
hook_event = input_data.get('hook_event_name', '')   # 直接读取，PascalCase
session_id = input_data.get('session_id', 'unknown')
tool_name  = input_data.get('tool_name', '')
cwd        = input_data.get('cwd', '')
```

Claude Code 的事件名已经是 PascalCase（如 `PreToolUse`），直接使用即可，无需额外转换。

### state_map 映射表

| hook_event_name | → 宠物 state | → dialogue | 备注 |
|---|---|---|---|
| `SessionStart` | `waving` | "嗨！小鸟来啦～" | 一次性动画，播完恢复 idle |
| `UserPromptSubmit` | `running` | "收到！开始工作～" | 循环动画 |
| `PreToolUse` | `running` | "执行中..." | 循环动画 |
| `PostToolUse` | `running` | "处理中..." | 硬编码（不在 state_map 中） |
| `Stop` | `jumping` | "搞定啦！✨" | 一次性动画，2s 后删除 session |
| `StopFailure` | `failed` | "呜...出了点问题" | terminal 事件，3s 后删除 session |
| `Notification` | `waving` | "注意哦～" | 一次性动画 |
| `PermissionRequest` | `waiting` | "需要你的授权～" | 循环动画，黄色警告气泡 |
| `SubagentStop` | `idle` | "" | 回到静息 |
| `PreCompact` | `waiting` | "整理一下记忆..." | 循环动画 |
| `SessionEnd` | `waving` | "下次见！♪" | terminal 事件，立即删除 session |

---

## 四、Hook 输出行为

宠物 hook 的设计原则是**对 Claude Code 完全透明**——不干预 Claude 的工作流，只做状态采集。

### Exit code

| 行为 | 含义 |
|---|---|
| `exit 0`（无输出） | 成功，Claude Code 正常继续 |
| `|| true` | shell 脚本末尾的保险，即使 Python 报错也不阻断 Claude |

### stdout

宠物 hook 不输出任何内容到 stdout。这很重要——因为：

- `UserPromptSubmit` 和 `SessionStart` 事件的 stdout 会被 Claude Code 作为额外上下文加入对话
- 如果宠物 hook 输出了调试信息，会被注入到 Claude 的 prompt 中，造成干扰

### stderr

调试信息（如配置加载失败）输出到 stderr，只会在 `claude --debug` 模式下可见。

### 不使用的高级功能

Claude Code hooks 支持丰富的输出控制（`permissionDecision: "deny"`, `decision: "block"` 等），但宠物 hook **不使用任何阻断能力**：

- 不返回 `exit 2`（不阻断任何工具调用）
- 不返回 JSON 输出（不修改 Claude 的行为）
- 不使用 `matcher`（匹配所有工具，不做筛选）

这确保宠物 hook 永远不会影响 Claude Code 的正常工作。

---

## 五、Claude Code Hook 运行时特性

了解 Claude Code 的 hook 运行机制，有助于理解宠物系统的可靠性：

| 特性 | 说明 |
|---|---|
| **超时** | 默认 60 秒，宠物 hook 通常 <100ms 完成 |
| **并行** | 所有匹配的 hook 并行执行，宠物 hook 不阻塞其他 hook |
| **去重** | 多个相同的 hook 命令会自动去重 |
| **环境变量** | `CLAUDE_PROJECT_DIR` 可用，但宠物 hook 不依赖它 |
| **工作目录** | 在 Claude Code 的当前目录执行 |
| **快照机制** | Claude Code 启动时拍摄 hook 配置快照，运行期间修改不立即生效 |
| **信任审查** | hook 修改后需要在 `/hooks` 菜单中审查才生效 |

---

## 六、一个完整的交互时序

用户在 Claude Code 中输入 "帮我修复这个 bug" 的完整时序：

```
时间    Claude Code                    Hook 脚本                         宠物渲染
─────────────────────────────────────────────────────────────────────────────────
t=0ms   UserPromptSubmit 事件
        → stdin JSON 发送给 hook      │
                                       claude_hook.py 解析
                                       → state: running, dialogue: "收到！开始工作～"
                                       → write session.json
                                       → push socket ✓
                                                              → transitionTo("running")
                                                              → bubble.show("收到！开始工作～")

t=200ms  Claude 分析中...              (无事件)

t=1s    PreToolUse(Bash)              claude_hook.py
        → stdin JSON                  → state: running, dialogue: "执行中..."
                                       → write + socket              → (状态未变，前端不动)

t=3s    PostToolUse(Bash)             claude_hook.py
                                       → state: running, dialogue: "处理中..."
                                       → write + socket              → (状态未变)

t=5s    PreToolUse(Edit)              同上

t=6s    PostToolUse(Edit)             同上

t=8s    Stop 事件
        → stdin JSON                  → state: jumping, dialogue: "搞定啦！✨"
                                       → write + socket
                                       → schedule_cleanup(2s)        → transitionTo("jumping") ← 一次性动画
                                                                     → bubble.show("搞定啦！✨")

t=10s   (2s timer fires)              session 文件被删除                → cleanup_stale()
                                                                     → aggregate → idle
                                                                     → transitionTo("idle")
                                                                     → bubble.hide()
```

---

## 七、相关文件

| 文件 | 职责 |
|---|---|
| `hooks/pet-claude-hook.sh` | Shell 入口，调用 Python |
| `hooks/scripts/claude_hook.py` | 解析 Claude Code stdin JSON |
| `hooks/scripts/common.py` | 共享逻辑：配置加载、状态映射、socket 推送 |
| `setup-hooks.sh` | 自动注册 hook 到 `~/.claude/settings.json` |
| `config.json` | state_map 映射表、socket 路径等配置 |
