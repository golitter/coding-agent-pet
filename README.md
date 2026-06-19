# coding-agent-pet

<p align="center">
  <img src="docs/images/coding-agent-pet-logo.png" alt="coding-agent-pet logo" width="96">
</p>

一个基于 Claude Code、Codex、OpenCode Hooks 的桌面虚拟宠物项目。
当前默认角色是像素风南琴梨（Kotori Minami），会随着 AI 编程助手的生命周期事件切换动画与气泡台词。

<p align="center">
  <strong>支持平台：</strong>Windows（支持 WSL2）· macOS
</p>

<p align="center">
  Claude Code (2.1.81) · OpenCode (1.17.3) · Codex CLI (0.139.0)
</p>

基于 [Tauri v2](https://v2.tauri.app/)（Rust + HTML/CSS/JS）构建。

<p align="center">
  <img src="docs/images/spritesheet.webp" alt="Kotori 精灵图（9 行 × 8 列，共 57 帧动画）" width="320">
</p>

> ↑ 完整精灵图：9 个状态行 × 8 列网格，共 57 帧动画。规格详见 [desktop/docs/reference/spritesheet.md](desktop/docs/reference/spritesheet.md)。

## 快速开始

在**仓库根目录**直接运行，脚本会自动识别平台（Windows → PowerShell，macOS/Linux → bash）：

```bash
python setup.py                      # 自动识别平台，一键完成依赖 → 配置 → hooks → 编译 → 启动
```

> 手动指定平台脚本、入口脚本目录结构、hooks 自动安装细节、`build-and-run` 用途等，详见 [desktop/README.md](desktop/README.md)。

## 交互

| 操作               | 效果                                             |
| ------------------ | ------------------------------------------------ |
| 悬停               | 跳跃 🎉                                          |
| 三连击（800ms 内） | 清空所有会话 🧹                                  |
| 点击消息框         | 折叠为右上角圆形会话计数徽标；点击徽标恢复消息框 |
| 拖动               | 移动位置（方向奔跑动画）                         |
| 右键               | 菜单：关闭宠物                                   |

## 架构

```
Claude Code / Codex → hook 脚本 (pet-hook.sh) ──┐
                                                 ├→ session 文件 + 事件端点 (Unix Socket / TCP loopback) → Tauri 渲染器
OpenCode           → TS 插件 (opencode-plugin.ts)┘     ├── Rust: 多会话聚合 + 双通道监听
                                                        └── JS: 精灵动画 + 对话气泡/折叠徽标 + 权限提示音
```

Windows / WSL2 场景下事件通道使用 TCP loopback（默认 `tcp://127.0.0.1:17361`）替代 Unix Socket。如果桌面宠物运行在 Windows，而 Claude Code / Codex / OpenCode 运行在 WSL2，请先启动 Windows 端宠物，再到 WSL2 内进入本仓库的 `desktop/cross-platform` 目录运行 `bash scripts/wsl/setup-hooks.sh`。完整配置步骤见 [desktop/README.md#WSL2-hooks](desktop/README.md#wsl2-hooks) 和 [desktop/docs/agent-hooks/wsl2.md](desktop/docs/agent-hooks/wsl2.md)。

状态优先级：`waiting > running > running-left/right > review > jumping > waving > idle > failed`

权限确认（`PermissionRequest`）会播放短提示音。消息框折叠时，右上角徽标显示当前活跃会话数；只要仍有待处理权限请求，徽标保持黄色提醒。

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
│   └── docs/               # 跨平台 / Hook / 精灵图 / Bugfix
└── docs/                   # 顶层文档（教程 + reference/details.md）
```

## 要求

- macOS 13+ / Windows 10/11（均已测试）· Rust + Cargo · Node.js + npm · Python 3

## License

MIT
