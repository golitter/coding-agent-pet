# Codex Hooks → 虚拟宠物渲染

OpenAI Codex 通过其 Hooks 系统在特定生命周期事件时，将 JSON 数据通过 stdin 传递给用户配置的命令行脚本。Kotori 虚拟宠物利用这一机制，监听 Codex 的工作状态并实时反映到桌面宠物的动画和对话中。

> **官方文档**: [Codex Hooks](https://developers.openai.com/codex/hooks)

---

## 一、配置注册

### 配置文件

Codex 的 hooks 可以通过两种格式配置：

**格式 1：hooks.json**（宠物 hook 使用这种）

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/desktop/cross-platform/hooks/pet-codex-hook.sh"
          }
        ]
      }
    ],
    "PreToolUse": [ ... ],
    "Stop": [ ... ]
  }
}
```

配置文件位置：
- `~/.codex/hooks.json` — 用户级（宠物 hook 注册在这里）
- `<repo>/.codex/hooks.json` — 项目级（需信任后才生效）

**格式 2：config.toml 内联**

```toml
[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = '/path/to/pet-codex-hook.sh'
timeout = 30
```

如果同一层级同时存在 `hooks.json` 和内联 `[hooks]`，Codex 会合并两者并打印警告。

### 注册脚本 — setup-hooks.sh

与 Claude Code 共用同一个 `setup-hooks.sh`，自动完成两个平台的配置：

```
1. 读取 config.json 获取路径
2. 清理旧版本 hook 条目
3. 为 9 个事件逐一添加 hook 条目
4. 原子写入到 ~/.codex/hooks.json
```

### 注册的 9 个事件

| 事件 | 触发时机 | 宠物用途 |
|---|---|---|
| `SessionStart` | 启动或恢复会话 | 宠物挥手："嗨！小鸟来啦～" |
| `UserPromptSubmit` | 用户提交 prompt | 宠物奔跑："收到！开始工作～" |
| `PreToolUse` | Codex 调用工具之前 | 宠物奔跑："执行中..." |
| `PostToolUse` | 工具执行完成后 | 宠物奔跑："处理中..." |
| `Stop` | Codex 完成响应 | 宠物跳跃："搞定啦！✨" |
| `StopFailure` | Codex 执行失败 | 宠物失败："呜...出了点问题" |
| `Notification` | 发送通知时 | 宠物挥手："注意哦～" |
| `PermissionRequest` | 请求权限时 | 宠物等待："需要你的授权～" |
| `SubagentStop` | 子代理完成时 | 宠物回到 idle |

**与 Claude Code 的差异**：

- Codex 没有注册 `PreCompact`，因为该事件在宠物 config 的 Codex 事件列表中未启用。
- Codex 也不注册 `SessionEnd`（Codex 当前不提供该事件，会话死亡检测依赖 [pseudo-session-end.md](../codex/v01330/pseudo-session-end.md) 的 SQLite 轮询方案）。
- **`SessionStart` 触发时机不同**（Codex 0.133.0 实测）：上表中"启动或恢复会话"是 Codex 平台官方说法，但实测 Codex 0.133.0 的 `session_start` 是**懒触发**——只在用户**首次提交 prompt** 时才连同 `user_prompt_submit` 一起补发（两者间隔 30~50ms），CLI/IDE 启动瞬间并不发。若用户启动 codex 后不发消息直接退出，两个事件都不会触发。证据见 `/tmp/kotori-pet-codex-hook.log` + `~/.codex/log/codex-tui.log`。结果：挥手动画（waving）会被紧随的奔跑动画（running）瞬时覆盖，肉眼几乎不可见。

### matcher 字段

宠物 hook 不使用 `matcher` 字段（省略或设为 `""`），匹配所有工具调用。

Codex 的 `matcher` 是一个**正则表达式**，可以精确匹配工具名：

| 事件 | matcher 过滤的内容 | 示例 |
|---|---|---|
| `PreToolUse` | tool_name | `"Bash"`, `"Edit|Write"`, `"mcp__fs__.*"` |
| `PostToolUse` | tool_name | 同上 |
| `PermissionRequest` | tool_name | 同上 |
| `SessionStart` | source | `"startup|resume"` |
| `SubagentStop` | agent_type | 子代理类型 |
| `Stop` | 不支持 matcher | — |
| `UserPromptSubmit` | 不支持 matcher | — |

---

## 二、信任机制

Codex 的 hook 信任机制与 Claude Code 不同，是一个重要的安全特性：

### 首次信任流程

```
setup-hooks.sh 写入 hook 配置
        │
        ▼
Codex 启动时发现新的/已变更的 hook
        │
        ▼
打印警告: "Some hooks need review. Open /hooks to review them."
        │
        ▼
用户在 CLI 中运行 /hooks 命令
        │
        ▼
审查 hook 命令内容 → 选择 Trust（信任）
        │
        ▼
Codex 记录 hook 的 hash → 下次启动自动信任
        │
        ▼
hook 开始正常执行
```

### 信任规则

| 规则 | 说明 |
|---|---|
| **Hash 校验** | 信任基于 hook 定义的当前 hash，命令变更后需重新审查 |
| **托管 hook** | 来自 system/MDM/cloud/requirements.toml 的 hook 自动信任，不可禁用 |
| **项目级 hook** | 只在项目 `.codex/` 被信任时才加载 |
| **跳过审查** | `--dangerously-bypass-hook-trust` 可跳过信任检查（CI/自动化场景） |
| **插件 hook** | 插件捆绑的 hook 也需审查后才能运行 |

**对宠物的影响**：首次安装后，用户需要通过 `/hooks` 手动信任宠物 hook，否则 hook 不会执行，宠物不会响应。

---

## 三、Hook 输入格式

Codex 通过 stdin 传递 JSON，字段命名与 Claude Code 有所不同。

### 通用字段（所有事件都有）

```json
{
  "session_id": "abc123...",
  "transcript_path": "/path/to/transcript",
  "cwd": "/Users/user/project",
  "hook_event_name": "PreToolUse",
  "model": "o3"
}
```

### PreToolUse 额外字段

```json
{
  "session_id": "...",
  "hook_event_name": "PreToolUse",
  "turn_id": "turn_001",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01ABC...",
  "tool_input": {
    "command": "npm test"
  },
  "permission_mode": "default"
}
```

### UserPromptSubmit 额外字段

```json
{
  "session_id": "...",
  "hook_event_name": "UserPromptSubmit",
  "turn_id": "turn_001",
  "prompt": "帮我重构这个模块",
  "permission_mode": "default"
}
```

### Stop 额外字段

```json
{
  "session_id": "...",
  "hook_event_name": "Stop",
  "turn_id": "turn_001",
  "stop_hook_active": false,
  "last_assistant_message": "我已经完成了重构...",
  "permission_mode": "default"
}
```

### SubagentStop 额外字段

```json
{
  "session_id": "...",
  "hook_event_name": "SubagentStop",
  "turn_id": "turn_001",
  "agent_id": "agent_001",
  "agent_type": "code-review",
  "agent_transcript_path": "/path/to/transcript",
  "stop_hook_active": false,
  "last_assistant_message": "..."
}
```

---

## 四、宠物 Hook 处理流程

### 入口：pet-codex-hook.sh → codex_hook.py

```
Codex 触发 hook
        │
        │ stdin JSON
        ▼
pet-codex-hook.sh
        │
        │ /usr/bin/python3 scripts/codex_hook.py
        ▼
codex_hook.py
        │
        │ 1. json.load(sys.stdin) 读取输入
        │ 2. 多字段名适配 + EVENT_ALIASES 转换
        │ 3. 调用 common.process_event()
        ▼
common.process_event()
        │
        │ 4. load_config() 加载 config.json
        │ 5. state_map 查表 → {state, dialogue}
        │ 6. 写 session 文件 (原子写入)
        │ 7. 推送 Unix socket
        │ 8. terminal 事件: 后端立即删除
        ▼
Tauri 渲染器 → 宠物动画更新
```

### Codex 特有的字段适配

Codex 的事件字段名存在多种形式，`codex_hook.py` 需要逐一尝试：

```python
# 1. 事件名：多种字段名 + snake_case → PascalCase 转换
raw_event = (
    input_data.get('hook_event_name')       # 优先使用标准字段
    or input_data.get('event')              # 兼容旧格式
    or input_data.get('codex_event_type')   # 兼容别名
    or ''
)
hook_event = EVENT_ALIASES.get(raw_event, raw_event)

# 2. Session ID：多种字段名
session_id = (
    input_data.get('session_id')
    or input_data.get('sessionId')
    or input_data.get('conversation_id')
    or input_data.get('thread_id')
    or 'unknown'
)

# 3. Tool name：多种字段名
tool_name = input_data.get('tool_name') or input_data.get('tool') or ''
```

### EVENT_ALIASES 完整映射

```python
EVENT_ALIASES = {
    'notification':        'Notification',
    'permission_request':  'PermissionRequest',
    'post_tool_use':       'PostToolUse',
    'pre_tool_use':        'PreToolUse',
    'session_start':       'SessionStart',
    'stop':                'Stop',
    'stop_failure':        'StopFailure',
    'subagent_stop':       'SubagentStop',
    'user_prompt_submit':  'UserPromptSubmit',
}
```

这个映射确保无论 Codex 传入 `snake_case` 还是 `PascalCase`，都能正确匹配 `config.json` 中的 `state_map`。

### state_map 映射表

与 Claude Code 完全一致（因为都使用同一个 `common.process_event()`）：

| hook_event (PascalCase) | → 宠物 state | → dialogue | 备注 |
|---|---|---|---|
| `SessionStart` | `waving` | "嗨！小鸟来啦～" | 一次性动画（⚠️ Codex 0.133.0 懒触发，被紧随的 running 瞬时覆盖，详见上文"与 Claude Code 的差异"） |
| `UserPromptSubmit` | `running` | "收到！开始工作～" | 循环动画 |
| `PreToolUse` | `running` | "执行中..." | 循环动画 |
| `PostToolUse` | `running` | "处理中..." | 硬编码 |
| `Stop` | `jumping` | "搞定啦！✨" | 一次性动画，2s 后删除 |
| `StopFailure` | `failed` | "呜...出了点问题" | terminal，立即删除 |
| `Notification` | `waving` | "注意哦～" | 一次性动画 |
| `PermissionRequest` | `waiting` | "需要你的授权～" | 黄色警告气泡 |
| `SubagentStop` | `idle` | "" | 回到静息 |

---

## 五、Hook 输出行为

### Exit code

| 行为 | 含义 |
|---|---|
| `exit 0` + stdout `{}` | 成功，Codex 正常继续 |
| `|| true` | shell 脚本末尾保险，即使 Python 报错也不阻断 Codex |

### stdout

Codex 的某些事件（如 `Stop`、`SubagentStop`）期望 stdout 返回 JSON。宠物 hook 在处理完成后输出空 JSON：

```python
# codex_hook.py 末尾
print('{}')
```

这确保 Codex 不会因为 stdout 不是有效 JSON 而报错。

### 不使用的高级功能

Codex hooks 支持丰富的输出控制，但宠物 hook **不使用任何**：

- 不返回 `decision: "block"`（不阻断工具调用或让 Codex 继续）
- 不返回 `permissionDecision: "deny"`（不拦截权限请求）
- 不返回 `hookSpecificOutput`（不注入额外上下文）
- 不使用 `systemMessage`（不显示系统消息）
- 不返回 `updatedInput`（不重写工具输入）

这确保宠物 hook 永远不会影响 Codex 的正常工作。

---

## 六、Codex Hook 运行时特性

| 特性 | 说明 |
|---|---|
| **超时** | 默认 600 秒，宠物 hook 通常 <100ms 完成 |
| **并行** | 多个匹配的 command hook 并行启动，互不阻塞 |
| **去重** | 相同的 hook 命令自动去重 |
| **环境变量** | `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` 可用（兼容字段） |
| **工作目录** | 在会话的 cwd 中执行 |
| **插件 hook** | 插件可通过 manifest 捆绑 hook，使用 `PLUGIN_ROOT` 环境变量 |
| **禁用** | `config.toml` 中 `[features] hooks = false` 可全局禁用 |
| **加载顺序** | 多层配置的 hook 全部加载，高优先级不会替换低优先级的 hook |

### Codex 独有的特性（Claude Code 没有）

| 特性 | 说明 |
|---|---|
| **插件 hook** | 插件可通过 `plugin.json` manifest 捆绑 hook |
| **managed_dir** | 企业管理员可通过 `requirements.toml` 指定托管 hook 脚本目录 |
| **allow_managed_hooks_only** | 强制只允许管理员 hook，忽略用户/项目级 hook |
| **TOML 格式** | 支持 `config.toml` 内联 hook 定义 |
| **commandWindows** | 支持 Windows 平台专用命令覆盖 |

---

## 七、调试

Codex hook 写入详细的调试日志到 `/tmp/kotori-pet-codex-hook.log`：

```json
{"time": "2026-06-08T10:09:16.998Z", "raw_event": "stop", "event": "Stop", "session_id": "f2f5b758...", "state": "jumping", "dialogue": "搞定啦！✨", "socket_exists": true, "sessions_dir": "/path/to/sessions"}
```

每条日志一行 JSON，包含：
- `time` — UTC 时间戳
- `raw_event` — Codex 原始事件名（可能是 snake_case）
- `event` — 转换后的 PascalCase 事件名
- `session_id` — 会话 ID
- `state` — 映射后的宠物状态
- `dialogue` — 映射后的对话文本
- `socket_exists` — 渲染器是否在运行
- `sessions_dir` — session 文件目录路径

通过 `log_path` 参数在 `codex_hook.py` 调用 `common.process_event()` 时传入。

---

## 八、一个完整的交互时序

用户在 Codex 中输入 "帮我修复这个 bug" 的完整时序：

```
时间    Codex                          Hook 脚本                         宠物渲染
─────────────────────────────────────────────────────────────────────────────────
t=0ms   UserPromptSubmit 事件
        → stdin JSON 发送给 hook      │
                                       codex_hook.py 解析
                                       raw_event = "user_prompt_submit"
                                       → EVENT_ALIASES → "UserPromptSubmit"
                                       → state: running, dialogue: "收到！开始工作～"
                                       → write session.json
                                       → push socket ✓
                                       → print('{}')
                                                              → transitionTo("running")
                                                              → bubble.show("收到！开始工作～")

t=200ms  Codex 分析中...              (无事件)

t=1s    PreToolUse(Bash)              codex_hook.py
        → stdin JSON                  raw_event = "pre_tool_use"
                                       → EVENT_ALIASES → "PreToolUse"
                                       → state: running, dialogue: "执行中..."
                                       → write + socket              → (状态未变)

t=3s    PostToolUse(Bash)             codex_hook.py
        → stdin JSON                  raw_event = "post_tool_use"
                                       → EVENT_ALIASES → "PostToolUse"
                                       → state: running, dialogue: "处理中..."
                                       → write + socket              → (状态未变)

t=5s    PreToolUse(apply_patch)       同上

t=6s    PostToolUse(apply_patch)      同上

t=8s    Stop 事件
        → stdin JSON                  raw_event = "stop"
                                       → EVENT_ALIASES → "Stop"
                                       → state: jumping, dialogue: "搞定啦！✨"
                                       → write + socket
                                       → schedule_cleanup(2s)
                                       → print('{}')                 → transitionTo("jumping") ← 一次性
                                                                     → bubble.show("搞定啦！✨")

t=10s   (2s timer fires)              session 文件被删除                → cleanup_stale()
                                                                     → aggregate → idle
                                                                     → bubble.hide()
```

---

## 九、相关文件

| 文件 | 职责 |
|---|---|
| `hooks/pet-codex-hook.sh` | Shell 入口，调用 Python |
| `hooks/scripts/codex_hook.py` | 解析 Codex stdin JSON，EVENT_ALIASES 转换 |
| `hooks/scripts/common.py` | 共享逻辑：配置加载、状态映射、socket 推送 |
| `setup-hooks.sh` | 自动注册 hook 到 `~/.codex/hooks.json` |
| `config.json` | state_map 映射表、socket 路径等配置 |
