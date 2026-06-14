# 🐦 Kotori 虚拟桌面宠物 (跨平台)

基于 [Tauri v2](https://v2.tauri.app/)（Rust + HTML/CSS/JS）的跨平台桌面宠物实现。一只像素风的南琴梨（Kotori Minami）住在你的桌面上，根据 AI 编程工具（Claude Code / Codex / OpenCode）的状态变化做出反应。

## 快速开始

```bash
cd desktop/cross-platform
cp config.example.json config.json   # 按需修改配置
bash setup.sh                        # 正式推荐：一键安装 & 启动
```

`setup.sh` 自动完成：安装前端依赖 → 生成配置 → 注册 hooks → 编译 → 启动。
正式使用时，推荐把 `bash setup.sh` 作为标准入口。
`./build-and-run.sh` 主要用于已经完成初始化后的开发态“编译并重启”。

### 已验证的 AI Coding CLI 版本

这些 hooks / 插件集成当前已按下列版本完成联调，若上游 CLI 后续改动 Hook 协议、事件字段或插件 API，可能需要同步适配：

- Claude Code：`2.1.81`
- OpenCode：`1.17.3`
- Codex CLI：`0.139.0`

### `setup.sh` / `setup-hooks.sh` 会做什么

- 自动写入或更新三套集成：
  - Claude Code → `~/.claude/settings.json`
  - Codex → `~/.codex/hooks.json`
  - OpenCode → `~/.config/opencode/plugins/pet-plugin.ts`
- 重新执行是幂等的：脚本会先清掉自己管理的 pet hook，再写回一份标准配置，不会越跑越多
- 对 Codex，脚本会尽量把已有 trust 记录的 pet hook 自动设成 `enabled = true`
- 但首次使用时，Codex 往往仍需要你在 `/hooks` 里手动 `Trust/Enable` 一次，因为脚本不会凭空生成 `trusted_hash`
- hooks 配置通常要在新会话或重启对应 CLI 后才会稳定生效

## 使用

| 操作                                    | 效果                              |
| --------------------------------------- | --------------------------------- |
| 悬停宠物                                | 触发跳跃动画 🎉                   |
| 三连击宠物（800ms 内）                  | 清空所有会话，气泡反馈清理数量 🧹 |
| 拖动宠物                                | 移动位置，宠物会跑起来            |
| 右键宠物                                | 菜单：关闭宠物                    |
| 正常使用 Claude Code、Codex 或 OpenCode | 宠物自动反应工作状态              |

## 动画状态

| 场景         | 动画        | 气泡台词         |
| ------------ | ----------- | ---------------- |
| 悬停宠物     | 跳跃 🎉     | —                |
| 启动会话     | 挥手 👋     | 嗨！小鸟来啦～   |
| 用户发送指令 | 奔跑 🏃     | 收到！开始工作～ |
| 执行工具     | 奔跑 🏃     | 执行中...        |
| 任务完成     | 跳跃 🎉     | 搞定啦！✨       |
| 需要授权     | 等待 ⚠️     | 需要你的授权～   |
| 出错         | 失败 💔     | 呜...出了点问题  |
| 拖动宠物     | 方向奔跑 →← | —                |
| 会话结束     | 挥手 👋     | 下次见！♪        |

## 架构

```
Claude Code / Codex → pet-hook.sh (shell+Python) ──┐
                                                    ├→ session 文件 + Unix Socket → Tauri 渲染器
OpenCode           → opencode-plugin.ts (TS 插件) ──┘     ├── Rust: agent 活动聚合 + 状态监听
                                                          └── JS: 精灵动画 + 对话气泡
```

支持多个 agent 同时活动，按优先级聚合状态（waiting > running > running-left/right > review > jumping > waving > idle > failed）。

### 安全措施

| 措施                 | 说明                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Socket 权限 `0o600`  | 仅 owner 可连接，防止本地注入                                                                 |
| AppleScript 内容过滤 | 拒绝 `do shell script` 和反引号                                                               |
| 最小 capabilities    | 仅声明实际使用的权限                                                                          |
| Mutex 合并           | 所有可变状态在单个 Mutex 后，消除死锁风险                                                     |
| 无 shell 拼接        | hook 不构造任何 shell 命令；session 生命周期（含 Stop 2s 延迟删除）由 Rust 后端经 socket 管理 |

## 目录结构

```
desktop/cross-platform/
├── config.example.json   # 配置模板
├── config.json           # 你的配置（自动生成，不入版本控制）
├── setup.sh              # 正式推荐入口（安装依赖 + hooks + 编译 + 启动）
├── build-and-run.sh      # 开发辅助：编译并重启
├── setup-hooks.sh        # 配置 hooks（Claude Code + Codex + OpenCode）
├── package.json          # 前端依赖（Tauri CLI + API）
├── src/                  # 前端
│   ├── index.html        #   入口 HTML
│   ├── main.js           #   主逻辑：窗口管理 + 交互事件
│   ├── animator.js       #   精灵动画引擎：状态切换 + 帧循环
│   ├── bubble.js         #   对话气泡：显示/隐藏 + 样式切换
│   └── style.css         #   样式
├── src-tauri/            # 后端 (Rust)
│   ├── Cargo.toml        #   Rust 依赖
│   ├── tauri.conf.json   #   Tauri 窗口/安全配置
│   └── src/
│       ├── main.rs       #   入口
│       ├── lib.rs        #   应用初始化：窗口透明 + 事件分发
│       ├── config.rs     #   配置加载 + 路径自动检测
│       ├── aggregator.rs #   agent 活动聚合器 (单 Mutex) + 优先级聚合
│       ├── watcher.rs    #   Unix Socket 服务端 + 文件监听 (防抖)
│       └── commands.rs   #   Tauri 命令：获取配置 / AppleScript (安全过滤) / 清空会话 / 退出
├── hooks/                # Hook 脚本
│   ├── pet-hook.sh           # Shell 入口 (claude-code / codex 参数分派)
│   ├── opencode-plugin.ts    # OpenCode 插件（TS，进程内运行，setup-hooks.sh 自动部署）
│   ├── opencode-shared.mjs   # OpenCode 共享逻辑（事件映射 / payload / IO）
│   └── scripts/            # Python 实现
│       ├── common.py       #   共享逻辑
│       ├── claude_hook.py  #   Claude Code 事件处理
│       ├── codex_hook.py   #   Codex 事件处理
│       ├── setup_hooks.py  #   Hook 注册逻辑
│       └── test_hooks.py   #   轻量测试（事件映射 / 配置写入）
├── hooks/tests/          # OpenCode 轻量测试（Node --test）
└── runtime/sessions/     # 运行时状态（不入版本控制）
```

## 配置

编辑 `config.json` 自定义，所有路径留 `null` 自动检测：

```json
{
  "pet_id": "kotori-minami",
  "renderer": {
    "scale": 0.6,
    "fps": 10,
    "corner_margin": 20
  },
  "dialogue": {
    "font_size": 10,
    "max_width": 160
  },
  "state_map": {
    "Stop": { "state": "jumping", "dialogue": "搞定啦！✨" },
    "StopFailure": { "state": "failed", "dialogue": "呜...出了点问题" }
  },
  "terminal_events": ["StopFailure", "SessionEnd"],
  "menu": {
    "items": [{ "title": "关闭宠物", "action": "quit" }]
  }
}
```

详见 [config.example.json](config.example.json)。修改后：

- 正式使用：运行 `bash setup.sh`
- 开发时快速重启：运行 `./build-and-run.sh`

### 日志

Rust 后端使用 `tracing` 框架，通过 `RUST_LOG` 环境变量控制日志级别：

```bash
RUST_LOG=debug ./src-tauri/target/debug/kotori-pet   # 详细日志
RUST_LOG=warn  ./src-tauri/target/debug/kotori-pet   # 仅警告
```

### 开发测试

```bash
npm run test:hooks   # hooks 轻量测试（Python unittest + Node --test）
```

## 要求

- macOS 13+（当前已测试平台）
- [Rust](https://rustup.rs/) + Cargo
- Node.js + npm
- Python 3（系统自带，hook 脚本使用）

## 相关文档

| 文档                                                                 | 说明                    |
| -------------------------------------------------------------------- | ----------------------- |
| [../docs/reference/overview.md](../docs/reference/overview.md)       | 跨平台实现概述          |
| [../docs/agent-hooks/README.md](../docs/agent-hooks/README.md)       | Hook 机制详解（三平台） |
| [../docs/reference/renderer.md](../docs/reference/renderer.md)       | Tauri 渲染器详解        |
| [../docs/reference/spritesheet.md](../docs/reference/spritesheet.md) | 精灵图规格              |
