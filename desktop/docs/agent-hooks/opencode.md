# OpenCode 插件系统（Hooks）参考

OpenCode 通过**插件系统（Plugin System）**扩展行为，本质上是 **协议 + 事件编程** 的组合——协议靠接口（TypeScript）定义，事件编程靠回调函数（观察者模式）实现。与 Claude Code / Codex 的"命令行 hook 脚本 + stdin JSON"模式不同，OpenCode 的 hook 以 JavaScript/TypeScript 模块的形式在进程内运行。

> **官方文档**: [OpenCode 插件](https://opencode.ai/docs/zh-cn/plugins/)
> **社区教程**: [OpenCode 插件系统详解](https://zhuanlan.zhihu.com/p/2027144829352583703)

---

## 一、核心概念

### Plugin 接口定义

```typescript
import type { Plugin, PluginContext, PluginHandlers } from '@opencode-ai/plugin';

// Plugin 本质是一个异步回调函数，接收上下文，返回事件处理器映射
type Plugin = (ctx: PluginInput) => Promise<Hooks>;
```

插件函数接收上下文参数，返回一个 **钩子对象（Hooks）**——键名为事件名，值为回调函数。

### 插件上下文（PluginContext）

```typescript
export const MyPlugin = async ({ project, client, $, directory, worktree }) => {
  // project   — 当前项目信息
  // directory — 当前工作目录
  // worktree  — git 工作树路径
  // client    — OpenCode SDK 客户端，用于与 AI 交互
  // $         — Bun 的 Shell API，用于执行命令
  return {
    // Hook implementations go here
  };
};
```

---

## 二、插件加载方式

### 方式 1：本地文件

将 JavaScript 或 TypeScript 文件放置在插件目录中，启动时自动加载：

| 级别 | 目录 |
|---|---|
| 项目级 | `.opencode/plugins/` |
| 全局级 | `~/.config/opencode/plugins/` |

### 方式 2：npm 包

在配置文件 `opencode.json` 中指定：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-helicone-session", "opencode-wakatime", "@my-org/custom-plugin"]
}
```

npm 插件在启动时使用 Bun 自动安装，缓存在 `~/.cache/opencode/node_modules/`。

### 加载顺序

插件从所有来源加载，所有钩子按顺序执行：

1. 全局配置 (`~/.config/opencode/opencode.json`)
2. 项目配置 (`opencode.json`)
3. 全局插件目录 (`~/.config/opencode/plugins/`)
4. 项目插件目录 (`.opencode/plugins/`)

名称和版本相同的重复 npm 包只加载一次；本地插件和名称相似的 npm 插件分别独立加载。

---

## 三、依赖管理

本地插件可以使用外部 npm 包，在配置目录中添加 `package.json`：

```json
{
  "dependencies": {
    "shescape": "^2.1.0"
  }
}
```

OpenCode 启动时运行 `bun install` 安装依赖，之后插件可直接 import。

---

## 四、事件列表

插件可订阅的事件（即 Hooks 的键名）分为以下类别：

### 会话事件（Session）

| 事件 | 触发时机 | 宠物潜在映射 |
|---|---|---|
| `session.created` | 创建新会话 | `waving` — "嗨！小鸟来啦～" |
| `session.updated` | 会话状态更新 | `running` — "工作中..." |
| `session.idle` | 会话空闲（AI 完成响应） | `jumping` — "搞定啦！✨" |
| `session.error` | 会话出错 | `failed` — "呜...出了点问题" |
| `session.deleted` | 会话被删除 | `waving` — "下次见！♪" |
| `session.compacted` | 上下文压缩 | `waiting` — "整理记忆..." |
| `session.diff` | 会话产生 diff | `running` — "处理中..." |
| `session.status` | 会话状态变化 | 通用状态更新 |

### 工具事件（Tool）

| 事件 | 触发时机 | 宠物潜在映射 |
|---|---|---|
| `tool.execute.before` | 工具执行**之前** | `running` — "执行中..." |
| `tool.execute.after` | 工具执行**之后** | `running` — "处理中..." |

### 消息事件（Message）

| 事件 | 触发时机 |
|---|---|
| `message.updated` | 消息更新 |
| `message.removed` | 消息删除 |
| `message.part.updated` | 消息片段更新 |
| `message.part.removed` | 消息片段删除 |

### 权限事件（Permission）

| 事件 | 触发时机 | 宠物潜在映射 |
|---|---|---|
| `permission.asked` | 请求权限 | `waiting` — "需要授权～" |
| `permission.replied` | 权限回复 | — |

### 文件事件（File）

| 事件 | 触发时机 |
|---|---|
| `file.edited` | 文件被编辑 |
| `file.watcher.updated` | 文件监视器更新 |

### 命令事件（Command）

| 事件 | 触发时机 |
|---|---|
| `command.executed` | 命令执行完毕 |

### Shell 事件

| 事件 | 触发时机 |
|---|---|
| `shell.env` | Shell 环境变量注入 |

### LSP 事件

| 事件 | 触发时机 |
|---|---|
| `lsp.client.diagnostics` | LSP 诊断 |
| `lsp.updated` | LSP 状态更新 |

### TUI 事件

| 事件 | 触发时机 |
|---|---|
| `tui.prompt.append` | TUI 追加 prompt |
| `tui.command.execute` | TUI 执行命令 |
| `tui.toast.show` | TUI 显示 toast |

### 其他事件

| 事件 | 触发时机 |
|---|---|
| `installation.updated` | 安装状态更新 |
| `server.connected` | 服务器连接 |
| `todo.updated` | 待办事项更新 |

---

## 五、Hook 回调签名

### 拦截型 Hook（before/after）

`tool.execute.before` 和 `tool.execute.after` 接收 `(input, output)` 双参数：

```typescript
export const MyPlugin = async (ctx) => {
  return {
    "tool.execute.before": async (input, output) => {
      // input.tool      — 工具名（如 "bash", "read"）
      // input.sessionID — 会话 ID（注意大写 D）
      // input.callID    — 调用 ID
      // output.args     — 可修改的工具参数
      if (input.tool === "bash") {
        console.log("即将执行:", output.args.command);
      }
    },
    "tool.execute.after": async (input, output) => {
      // input: { tool, sessionID, callID }
      // output: { title, output, metadata }
    },
  };
};
```

- **`input`**（只读）：`{ tool, sessionID, callID }` — 包含工具名、会话 ID、调用 ID
- **`output`**（可修改）：可以修改工具参数、阻断执行等

> **注意**：`sessionID` 是大写 D（不是 `sessionId`）。这是 OpenCode 插件 API 的命名约定，JS 区分大小写。

### 事件型 Hook（event）

通用事件订阅，接收 `({ event })` 参数。事件对象结构为 `{ id, type, properties }`，session ID 位于 `event.properties.sessionID`：

```typescript
export const NotificationPlugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await $`osascript -e 'display notification "Session completed!" with title "opencode"'`;
      }
    },
  };
};
```

> **注意**：事件中的 session ID 在 `event.properties.sessionID`（嵌套在 `properties` 里），不是 `event.sessionID`。`event.id` 是**事件 ID**（`evt_xxx` 格式），不是会话 ID（`ses_xxx` 格式）。

### 环境注入 Hook（shell.env）

```typescript
export const EnvPlugin = async () => {
  return {
    "shell.env": async (input, output) => {
      output.env.MY_API_KEY = "secret";
      output.env.PROJECT_ROOT = input.cwd;
    },
  };
};
```

### 压缩 Hook（experimental.session.compacting）

```typescript
export const CompactionPlugin: Plugin = async (ctx) => {
  return {
    "experimental.session.compacting": async (input, output) => {
      // 注入额外上下文到压缩 prompt
      output.context.push(`
## Custom Context
- Current task status
- Important decisions made
      `);

      // 或者完全替换压缩 prompt（设置 output.prompt 后 output.context 被忽略）
      // output.prompt = "You are generating a continuation prompt...";
    },
  };
};
```

---

## 六、自定义工具

插件不仅可以订阅事件，还能为 OpenCode 添加自定义工具：

```typescript
import { type Plugin, tool } from "@opencode-ai/plugin";

export const CustomToolsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "This is a custom tool",
        args: {
          foo: tool.schema.string(),
        },
        async execute(args, context) {
          const { directory, worktree } = context;
          return `Hello ${args.foo} from ${directory} (worktree: ${worktree})`;
        },
      }),
    },
  };
};
```

`tool` 辅助函数使用 Zod schema 定义参数，自定义工具与内置工具一起在 OpenCode 中可用。

---

## 七、与 Claude Code / Codex Hooks 的对比

| | Claude Code | Codex | **OpenCode** |
|---|---|---|---|
| **机制** | 命令行脚本 + stdin JSON | 命令行脚本 + stdin JSON | **JS/TS 模块，进程内运行** |
| **语言** | 任意（shell 调 Python） | 任意（shell 调 Python） | **JavaScript / TypeScript** |
| **配置位置** | `~/.claude/settings.json` | `~/.codex/hooks.json` | `.opencode/plugins/` 目录 / `opencode.json` |
| **加载方式** | 按事件名注册 command | 按事件名注册 command | 导出函数 + 按事件名返回 handler |
| **事件字段** | `hook_event_name` (PascalCase) | 多种字段名 + snake_case | **事件名即对象键名** |
| **运行时** | 独立进程，stdin/stdout 通信 | 独立进程，stdin/stdout 通信 | **进程内，直接函数调用** |
| **通信方式** | stdin JSON → stdout JSON | stdin JSON → stdout `{}` | 函数参数 `(input, output)` |
| **阻断能力** | exit 2 阻断 | `decision: "block"` | throw Error 阻断 |
| **自定义工具** | ❌ | ❌ | ✅ `tool()` API |
| **环境注入** | ❌ | ❌ | ✅ `shell.env` hook |
| **依赖管理** | — | — | Bun + package.json |
| **推荐语言** | — | — | TypeScript（类型安全） |

### 关键差异

1. **进程模型**：Claude Code / Codex 的 hook 是独立进程（spawn + stdin pipe），OpenCode 的 plugin 是进程内模块（import/require）。
2. **通信方式**：Claude Code / Codex 通过 stdin/stdout 传递 JSON；OpenCode 通过函数参数 `(input, output)` 传递，output 对象可直接修改。
3. **扩展能力**：OpenCode 的插件不仅限于事件订阅，还能添加自定义工具（`tool()` API），这是 Claude Code / Codex hook 不具备的。

---

## 八、示例插件

### 发送通知

```typescript
export const NotificationPlugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await $`osascript -e 'display notification "Session completed!" with title "opencode"'`;
      }
    },
  };
};
```

### .env 文件保护

```typescript
export const EnvProtection = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" && output.args.filePath.includes(".env")) {
        throw new Error("Do not read .env files");
      }
    },
  };
};
```

### 注入环境变量

```typescript
export const InjectEnvPlugin = async () => {
  return {
    "shell.env": async (input, output) => {
      output.env.MY_API_KEY = "secret";
      output.env.PROJECT_ROOT = input.cwd;
    },
  };
};
```

### 结构化日志

```typescript
export const MyPlugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "my-plugin",
      level: "info",
      message: "Plugin initialized",
      extra: { foo: "bar" },
    },
  });
};
```

日志级别：`debug`、`info`、`warn`、`error`。

---

## 九、宠物集成（Production Integration）

> 已实现。生产版插件位于 `desktop/cross-platform/hooks/opencode-plugin.ts`，由 `setup-hooks.sh` 自动部署到 `~/.config/opencode/plugins/pet-plugin.ts`。

OpenCode 的插件在进程内运行（Bun 运行时），采用与 Claude Code/Codex 等价的文件系统 + Unix socket 方案：

1. **Config 加载**：从同伴文件 `~/.config/opencode/plugins/.kotori-pet-config-dir` 读取 `desktop/cross-platform/` 路径，加载 `config.json` 获取 `state_map`、`sessions_dir`、`socket_path`、`terminal_events`
2. **Repo Root 检测**：`detectRepoRoot()` 从 platform dir 向上推导仓库根目录（识别 `desktop/cross-platform` 双层结构 → 向上两级），供路径解析使用
3. **路径解析**：`resolvePath()` 以 repo root（非 platform dir）为基准解析相对路径和 fallback 路径（fallback 为 `{repoRoot}/desktop/cross-platform/runtime/sessions`），与 Rust 后端的 `pet_base_dir` 检测逻辑保持一致
4. **异步写入 session 文件**：`fs.promises.writeFile(.tmp)` + `fs.promises.rename(.tmp, target)` 原子写入，格式与 `common.py` 完全一致
5. **Unix socket 推送**：`node:net` 的 `createConnection()`，fire-and-forget（不 await），100ms 超时，失败静默
6. **错误隔离**：所有逻辑包裹在 try/catch 中，插件异常不影响 OpenCode 运行

### 部署

```bash
cd desktop/cross-platform && ./setup-hooks.sh
# 自动复制 opencode-plugin.ts → ~/.config/opencode/plugins/pet-plugin.ts
# 自动写入 .kotori-pet-config-dir 同伴文件
```

### 事件映射

| OpenCode 事件 | PascalCase | 宠物 state |
|---|---|---|
| `session.created` | `SessionStart` | `waving` |
| `session.idle` | `Stop` | `jumping` |
| `session.error` | `StopFailure` | `failed` |
| `session.deleted` | `SessionEnd` | `waving` |
| `session.compacted` | `PreCompact` | `waiting` |
| `permission.asked` | `PermissionRequest` | `waiting` |
| `tool.execute.before` | `PreToolUse` | `running` |
| `tool.execute.after` | `PostToolUse` | `running` |
| `question` 工具 (before) | `QuestionAsked` | `waiting` |

### 已知限制

- **无 `UserPromptSubmit` 映射**：OpenCode API 无此事件，用户发消息后宠物保持 `waving` 直到首次 `PreToolUse`
- **同步 I/O 避免**：使用 `fs.promises.*` 异步版本，避免阻塞 Bun 主进程事件循环

---

## 十、参考资料

| 资源 | 链接 |
|---|---|
| OpenCode 官方插件文档 | <https://opencode.ai/docs/zh-cn/plugins/> |
| OpenCode 社区插件示例 | <https://opencode.ai/docs/zh-cn/plugins/#examples> |
| 插件系统详解（知乎） | <https://zhuanlan.zhihu.com/p/2027144829352583703> |
| `@opencode-ai/plugin` 类型定义 | npm 包 |
