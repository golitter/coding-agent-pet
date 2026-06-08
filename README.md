# 🐦 Kotori Pet

一只住在桌面上的小鸟 — 南琴梨（Kotori Minami）像素风格桌面宠物。她跟随 AI 编程工具（Claude Code / Codex）的状态变化做出反应。

基于 [Tauri v2](https://v2.tauri.app/) 构建（Rust 后端 + HTML/CSS/JS 前端），具备跨平台潜力。

## 快速开始

```bash
cd desktop/cross-platform
cp config.example.json config.json   # 按需修改配置
./setup.sh                           # 一键安装 & 启动
```

`setup.sh` 自动完成：安装前端依赖 → 生成配置 → 注册 hooks → 编译 → 启动。

## 架构

```
Claude Code / Codex → JSON 事件 (hooks) → session 文件 → Unix Socket → Tauri 渲染器
                                                                            ├── Rust: 会话聚合 + 状态监听
                                                                            └── JS: 精灵动画 + 对话气泡
```

支持多会话同时运行，按优先级聚合状态。

## 内置 Codex 中使用

通过 Codex Skill 自动生成宠物素材，详见 [教程文档](docs/codex实现虚拟宠物.md)。

## 文档

| 文档 | 说明 |
|---|---|
| [desktop/docs/overview.md](desktop/docs/overview.md) | 跨平台实现概述 |
| [desktop/docs/agent-hooks/README.md](desktop/docs/agent-hooks/README.md) | Hook 机制详解（各平台） |
| [desktop/docs/renderer.md](desktop/docs/renderer.md) | Tauri 渲染器详解 |
| [desktop/docs/spritesheet.md](desktop/docs/spritesheet.md) | 精灵图规格 |

## 目录结构

```
.
├── assets/kotori-minami/  # 宠物资料包 (frames 运行时资源 + imagegen 生成工件)
├── desktop/
│   ├── cross-platform/    # 主实现 (Tauri)
│   │   ├── src/           #   前端 (HTML/CSS/JS)
│   │   ├── src-tauri/     #   后端 (Rust)
│   │   ├── hooks/         #   Hook 脚本
│   │   └── runtime/sessions/  运行时状态
│   └── docs/              #   文档 (架构/hook/渲染器)
└── docs/                  # 顶层文档 (生成教程)
```

## 要求

- macOS 13+（当前已测试平台）
- [Rust](https://rustup.rs/) + Cargo
- Node.js + npm
- Python 3（系统自带，hook 脚本使用）

## License

MIT
