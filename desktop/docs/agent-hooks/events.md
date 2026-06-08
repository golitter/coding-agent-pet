# Hook 事件类型对照表

所有 Hook 事件的统一参考：哪个平台支持、宠物如何响应、是否触发 session 清理。

> 平台专属实现细节（输入字段、信任机制、调试输出等）见 [claude-code.md](claude-code.md) 和 [codex.md](codex.md)。

---

## 一、事件总表

宠物状态来自 `config.json` 的 `state_map`（两个平台共用），Codex 的 snake_case 事件名通过 `codex_hook.py` 的 `EVENT_ALIASES` 归一化为 PascalCase 后再查表。

| 事件 (PascalCase) | Codex snake_case | Claude Code | Codex | 宠物 state | 对话 | 备注 |
|---|---|:-:|:-:|---|---|---|
| `SessionStart` | `session_start` | ✓ | ✓ | `waving` | 嗨！小鸟来啦～ | 一次性动画，播完回 idle |
| `UserPromptSubmit` | `user_prompt_submit` | ✓ | ✓ | `running` | 收到！开始工作～ | 循环动画 |
| `PreToolUse` | `pre_tool_use` | ✓ | ✓ | `running` | 执行中... | 循环动画 |
| `PostToolUse` | `post_tool_use` | ✓ | ✓ | `running` * | 处理中... * | *硬编码，不查 state_map |
| `Stop` | `stop` | ✓ | ✓ | `jumping` | 搞定啦！✨ | 一次性动画，**2s 延迟删除** |
| `StopFailure` | `stop_failure` | ✓ | ✓ | `failed` | 呜...出了点问题 | **terminal，立即删除** |
| `Notification` | `notification` | ✓ | ✓ | `waving` | 注意哦～ | 一次性动画 |
| `PermissionRequest` | `permission_request` | ✓ | ✓ | `waiting` | 需要你的授权～ | 黄色警告气泡 |
| `SubagentStop` | `subagent_stop` | ✓ | ✓ | `idle` | (空) | 回到静息，仍计入 active_count |
| `PreCompact` | — | ✓ | ✗ | `waiting` | 整理一下记忆... | **Claude 独有** |
| `SessionEnd` | — | ✓ | ✗ | `waving` | 下次见！♪ | **Claude 独有**，terminal，立即删除 |

**注册数**：Claude Code 11 个，Codex 9 个。

**注意**：
- **SessionStart 触发时机不同**：Claude Code 在 CLI/IDE **启动瞬间**就触发 `SessionStart`，与首次 `UserPromptSubmit` 之间隔用户思考时间（秒～分钟级）；Codex 0.133.0 的 `session_start` 是**懒触发**——只在用户**首次提交 prompt** 时与 `user_prompt_submit` 一起补发（间隔仅 30~50ms）。若用户启动 codex 后不发消息直接退出，两个事件都不会发。结果：Codex 的挥手动画会被紧随的奔跑动画瞬时覆盖，肉眼几乎不可见。
- **`SessionEnd` Claude 独有**：Codex 不提供此事件，会话死亡检测依赖 [pseudo-session-end](../codex/v01330/pseudo-session-end.md) 的 SQLite 轮询兜底（详见第 25、39 行表格）。

---

## 二、按生命周期阶段分组

### 1. 会话生命周期（lifecycle）

| 事件 | 触发时机 | Claude Code 行为 | Codex 行为 |
|---|---|---|---|
| `SessionStart` | 启动或恢复会话 | 写 session 文件，挥手问候 | 同左 |
| `SessionEnd` | 会话结束（退出/关窗口） | 立即删除 session 文件，挥手告别 | **不触发**（Codex 不提供此事件，依赖 [pseudo-session-end](../codex/v01330/pseudo-session-end.md) SQLite 轮询兜底） |

### 2. 用户交互（user input）

| 事件 | 触发时机 | Claude Code 行为 | Codex 行为 |
|---|---|---|---|
| `UserPromptSubmit` | 用户提交 prompt | 宠物奔跑"收到！开始工作～" | 同左 |
| `Notification` | 系统通知（如等待用户输入） | 挥手"注意哦～" | 同左 |
| `PermissionRequest` | 请求工具执行权限 | 等待"需要你的授权～" + 黄色气泡 | 同左 |

### 3. 工具调用（tool use）

| 事件 | 触发时机 | Claude Code 行为 | Codex 行为 |
|---|---|---|---|
| `PreToolUse` | 调用工具前 | 奔跑"执行中..." | 同左 |
| `PostToolUse` | 工具返回后 | 奔跑"处理中..."（硬编码） | 同左 |

### 4. 响应结束（response end）

| 事件 | 触发时机 | Claude Code 行为 | Codex 行为 |
|---|---|---|---|
| `Stop` | 完成响应 | 跳跃"搞定啦！✨"，**2s 后删除 session**（期间收到新事件则取消删除） | 同左 |
| `StopFailure` | 响应失败 | 失败"呜...出了点问题"，**terminal 立即删除** | 同左 |
| `SubagentStop` | 子代理完成 | 回 idle（仍计入 active_count） | 同左 |

### 5. 上下文管理（context management）

| 事件 | 触发时机 | Claude Code 行为 | Codex 行为 |
|---|---|---|---|
| `PreCompact` | 压缩上下文前 | 等待"整理一下记忆..." | **不注册**（Codex 未启用） |

---

## 三、Session 清理规则对照

session 文件的生命周期由事件的 `isTerminal` 标志和事件类型共同决定（实际执行由 Rust 后端 [session.rs](../../cross-platform/src-tauri/src/session.rs) 完成）：

| 触发 | 删除时机 | 取消条件 | 覆盖场景 |
|---|---|---|---|
| `Stop` | **2s 后删除** | 期间收到新事件（state 不再是 `jumping`）→ 取消 | 正常完成一轮对话 |
| `StopFailure` | **立即删除** | 不可取消 | 响应失败 |
| `SessionEnd`（Claude 独有） | **立即删除** | 不可取消 | Claude Code 会话退出 |
| (无 terminal 事件) | **stale_timeout_sec 后清理**（默认 1h） | — | 进程崩溃 / kill -9 / UI 删对话 |
| (Codex 崩溃) | pseudo-session-end 轮询 **~5min 后清理** | — | Codex 异常退出 |

> **关键**：hook 脚本本身不做延迟删除（短生命周期进程的 timer 会被 kill），所有清理逻辑都在长生命周期的 Rust 后端。

---

## 四、平台差异速查

| 维度 | Claude Code | Codex |
|---|---|---|
| 独有事件 | `PreCompact`, `SessionEnd` | — |
| 缺失事件 | — | `PreCompact`, `SessionEnd` |
| 事件名格式 | PascalCase 直接读 | snake_case → `EVENT_ALIASES` 归一化 |
| 字段名 | 固定 `hook_event_name` | 多种（`hook_event_name` / `event` / `codex_event_type`） |
| Session ID 字段 | `session_id` | `session_id` / `sessionId` / `conversation_id` / `thread_id` |
| 崩溃兜底 | 1h TTL | 1h TTL + pseudo-session-end SQLite 轮询（~5min） |

---

## 五、相关文件

| 文件 | 作用 |
|---|---|
| [claude-code.md](claude-code.md) | Claude Code hook 实现细节 |
| [codex.md](codex.md) | Codex hook 实现细节 |
| [../../cross-platform/hooks/scripts/common.py](../../cross-platform/hooks/scripts/common.py) | 共享处理逻辑（state_map 查表、socket 推送） |
| [../../cross-platform/config.example.json](../../cross-platform/config.example.json) | `state_map` + `terminal_events` 配置 |
| [../../cross-platform/src-tauri/src/session.rs](../../cross-platform/src-tauri/src/session.rs) | Rust 后端：terminal 删除、Stop 延迟取消 |
| [../../cross-platform/src-tauri/src/watcher.rs](../../cross-platform/src-tauri/src/watcher.rs) | Socket 服务端 + Stop 2s 延迟调度 |
| [../codex/v01330/pseudo-session-end.md](../codex/v01330/pseudo-session-end.md) | Codex 无 SessionEnd 的兜底方案 |
