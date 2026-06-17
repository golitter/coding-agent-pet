# coding-agent-pet

<p align="center">
  <img src="docs/images/coding-agent-pet-logo.png" alt="coding-agent-pet logo" width="96">
</p>

一个基于 Claude Code、Codex、OpenCode Hooks 的桌面虚拟宠物项目。
当前默认角色是像素风南琴梨（Kotori Minami），会随着 AI 编程助手的生命周期事件切换动画与气泡台词。

<p align="center">
  Claude Code (2.1.81) · OpenCode (1.17.3) · Codex CLI (0.139.0)
</p>

基于 [Tauri v2](https://v2.tauri.app/)（Rust + HTML/CSS/JS）构建。

<p align="center">
  <img src="docs/images/spritesheet.webp" alt="Kotori 精灵图（9 行 × 8 列，共 57 帧动画）" width="320">
</p>

> ↑ 完整精灵图：9 个状态行 × 8 列网格，共 57 帧动画。规格详见 [desktop/docs/reference/spritesheet.md](desktop/docs/reference/spritesheet.md)。

## 快速开始

```bash
cd desktop/cross-platform
cp config.example.json config.json   # 按需修改

# macOS / Linux
bash scripts/macos/setup.sh          # 正式推荐：一键完成依赖 → 配置 → hooks → 编译 → 启动

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File scripts/windows/setup.ps1
```

入口脚本按平台分目录：`scripts/macos/`（`setup.sh` / `setup-hooks.sh` / `build-and-run.sh`）、`scripts/windows/`（对应 `.ps1`）。源码 `src/`、`src-tauri/`、`hooks/`、配置等保持单份共享。

`setup.sh` / `setup.ps1` 会自动安装 Claude Code / Codex / OpenCode 三套 hooks 集成；重复执行不会重复追加。
其中 Codex 会自动写入 hook，并尽量启用已有 trust 记录的条目，但首次使用通常仍需要在 `/hooks` 里手动 `Trust/Enable` 一次。

日常首次安装、换机、或者完整更新时，推荐始终使用 `setup.sh` / `setup.ps1`。
`build-and-run.sh` / `build-and-run.ps1` 更适合已经完成初始化后的开发态增量重启。

## 交互

| 操作 | 效果 |
|---|---|
| 悬停 | 跳跃 🎉 |
| 三连击（800ms 内） | 清空所有会话 🧹 |
| 拖动 | 移动位置（方向奔跑动画） |
| 右键 | 菜单：关闭宠物 |

## 架构

```
Claude Code / Codex → hook 脚本 (pet-hook.sh) ──┐
                                                 ├→ session 文件 + Unix Socket → Tauri 渲染器
OpenCode           → TS 插件 (opencode-plugin.ts)┘     ├── Rust: 多会话聚合 + 双通道监听
                                                        └── JS: 精灵动画 + 对话气泡
```

状态优先级：`waiting > running > running-left/right > review > jumping > waving > idle > failed`

## 在 Codex 中生成宠物素材

通过 Codex Skill 一键生成像素资料包，详见 [教程](docs/codex实现虚拟宠物.md)。

## 文档

完整索引（架构 / Hook 协议 / 源码 / 配置 / 精灵图规格 / Bugfix）详见
[docs/reference/details.md](docs/reference/details.md)。

## 目录结构

```text
.
├── assets/kotori-minami/   # 资料包（frames/ 运行时 + imagegen/ 生成工件）
├── desktop/
│   ├── cross-platform/     # Tauri 主实现（src/ + src-tauri/ + hooks/）
│   │   └── hooks/          #   pet-hook.sh (Claude/Codex) + opencode-plugin.ts (OpenCode)
│   └── docs/               # 跨平台 / Hook / 精灵图 / Bugfix
└── docs/                   # 顶层文档（教程 + reference/details.md）
```

## 要求

- macOS 13+ · [Rust](https://rustup.rs/) + Cargo · Node.js + npm · Python 3

## License

MIT
