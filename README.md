# 🐦 Kotori Pet

一只住在 macOS 桌面上的小鸟 — 南琴梨（Kotori Minami）像素风格桌面宠物。

她会跟随你的 AI 编程工具（Claude Code / OpenAI Codex）的状态变化做出反应：开始工作时奔跑，执行命令时翻阅资料，任务完成时欢呼跳跃，出错了也会难过地蹲下。

## 快速开始

```bash
cd desktop/mac
cp config.example.json config.json   # 按需修改配置
./setup.sh                           # 一键安装 & 启动
```

## 架构

```
Claude Code / Codex
       │ JSON 事件 (hooks)
       ▼
  session 文件 ──▶ Unix Socket ──▶ Swift 渲染器（透明悬浮窗口）
```

- **Hooks** — 接收 AI 工具事件，映射到动画状态，写入 session 文件并推送更新
- **渲染器** — Swift/AppKit 实现，读取精灵图，驱动动画和对话气泡
- **多会话** — 支持同时跟踪多个 AI 会话，按优先级聚合状态

## 动画状态

| 状态 | 触发场景 | 优先级 |
|------|---------|--------|
| waiting | 等待用户授权 / 整理记忆 | 8 |
| running | 执行工具调用 | 7 |
| running-right / running-left | 拖动宠物时方向奔跑 | 6 |
| review | 读取/编辑/写入文件 | 5 |
| jumping | 任务完成 | 4 |
| waving | 会话开始 / 通知 | 3 |
| idle | 空闲待机 | 1 |
| failed | 执行出错 | 0 |

> 多会话同时运行时，优先级高的状态会覆盖低的展示在宠物上。

## 目录结构

```
desktop/mac/
├── renderer/          # Swift 渲染器（SPM 项目）
├── hooks/             # Claude Code / Codex 事件钩子
├── runtime/sessions/  # 运行时会话数据（gitignore）
├── config.example.json
├── setup.sh           # 一键安装脚本
└── build-and-run.sh   # 编译 & 运行
```

## 配置

复制 `config.example.json` 为 `config.json`，可自定义动画映射、对话文本、渲染参数和右键菜单。

## License

MIT
