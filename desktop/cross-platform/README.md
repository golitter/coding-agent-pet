# 🐦 Kotori 虚拟桌面宠物 (跨平台)

基于 [Tauri v2](https://v2.tauri.app/)（Rust + HTML/CSS/JS）的跨平台桌面宠物实现。一只像素风的南琴梨（Kotori Minami）住在你的桌面上，根据 AI 编程工具（Claude Code / Codex）的状态变化做出反应。

## 快速开始

```bash
cd desktop/cross-platform
cp config.example.json config.json   # 按需修改配置
./setup.sh                           # 一键安装 & 启动
```

`setup.sh` 自动完成：安装前端依赖 → 生成配置 → 注册 hooks → 编译 → 启动。

## 使用

| 操作                          | 效果                                  |
| ----------------------------- | ------------------------------------- |
| 点击宠物                      | 触发跳跃动画 🎉                       |
| 拖动宠物                      | 移动位置，宠物会跑起来                |
| 右键宠物                      | 菜单：打开 Codex / VS Code / 关闭宠物 |
| 正常使用 Claude Code 或 Codex | 宠物自动反应工作状态                  |

## 动画状态

| 场景         | 动画        | 气泡台词         |
| ------------ | ----------- | ---------------- |
| 点击宠物     | 跳跃 🎉     | —                |
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
Claude Code / Codex → JSON 事件 (hooks) → session 文件 → Unix Socket → Tauri 渲染器
     │                                       │                              ├── Rust: 会话聚合 + 状态监听
     │                                       └── 文件系统监听 (notify crate)  └── JS: 精灵动画 + 对话气泡
     └── hook 脚本写入 session 文件并通过 Unix Socket 推送
```

支持多会话同时运行，按优先级聚合状态（waiting > running > review > jumping > waving > idle > failed）。

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
├── setup.sh              # 一键安装（安装依赖 + hooks + 编译 + 启动）
├── build-and-run.sh      # 编译并重启
├── setup-hooks.sh        # 配置 hooks（Claude Code + Codex）
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
│       ├── session.rs    #   多会话管理器 (单 Mutex) + 优先级聚合
│       ├── watcher.rs    #   Unix Socket 服务端 + 文件监听 (防抖)
│       └── commands.rs   #   Tauri 命令：获取配置 / AppleScript (安全过滤) / 退出
├── hooks/                # Hook 脚本
│   ├── pet-claude-hook.sh  # Claude Code hook 入口
│   ├── pet-codex-hook.sh   # Codex hook 入口
│   └── scripts/            # Python 实现
│       ├── common.py       #   共享逻辑
│       ├── claude_hook.py  #   Claude Code 事件处理
│       └── codex_hook.py   #   Codex 事件处理
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
    "Stop": { "state": "jumping", "dialogue": "搞定啦！✨" }
  },
  "menu": {
    "items": [
      {
        "title": "Codex",
        "action": "applescript",
        "script": "tell application \"Codex\"\nactivate\nend tell"
      },
      { "type": "separator" },
      { "title": "关闭宠物", "action": "quit" }
    ]
  }
}
```

详见 [config.example.json](config.example.json)。修改后运行 `./build-and-run.sh` 重启生效。

### 日志

Rust 后端使用 `tracing` 框架，通过 `RUST_LOG` 环境变量控制日志级别：

```bash
RUST_LOG=debug ./src-tauri/target/debug/kotori-pet   # 详细日志
RUST_LOG=warn  ./src-tauri/target/debug/kotori-pet   # 仅警告
```

## 要求

- macOS 13+（当前已测试平台）
- [Rust](https://rustup.rs/) + Cargo
- Node.js + npm
- Python 3（系统自带，hook 脚本使用）

## 相关文档

| 文档                                                           | 说明                    |
| -------------------------------------------------------------- | ----------------------- |
| [../docs/overview.md](../docs/overview.md)                     | 跨平台实现概述          |
| [../docs/agent-hooks/README.md](../docs/agent-hooks/README.md) | Hook 机制详解（各平台） |
| [../docs/renderer.md](../docs/renderer.md)                     | Tauri 渲染器详解        |
| [../docs/spritesheet.md](../docs/spritesheet.md)               | 精灵图规格              |
