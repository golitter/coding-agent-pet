# 🐦 Kotori Pet

基于 [Tauri v2](https://v2.tauri.app/)（Rust + HTML/CSS/JS）的跨平台桌面宠物。像素风南琴梨（Kotori Minami）跟随 Claude Code / Codex / OpenCode 的生命周期事件切换动画与气泡台词。

> 技术参考详见 [docs/reference/details.md](docs/reference/details.md)

## 目录结构

```text
.
├── assets/kotori-minami/   # 资料包：frames/ 运行时 + imagegen/ 生成工件
├── desktop/
│   ├── cross-platform/     # Tauri 主实现（src/ + src-tauri/ + hooks/）
│   │   ├── hooks/          #   pet-hook.sh (Claude/Codex) + opencode-plugin.ts (OpenCode)
│   │   └── scripts/        #   平台入口脚本：macos/ (*.sh) + windows/ (*.ps1)
│   └── docs/               # 跨平台 / Hook / 精灵图 / Bugfix 文档
├── docs/                   # 顶层文档（教程 + reference/details.md）
├── AGENTS.md               # 本文件
├── CLAUDE.md               # → @AGENTS.md
└── README.md
```

## 核心命令

```bash
python setup.py                     # 顶层入口：自动识别平台，全流程（依赖→配置→hooks→编译→启动）

# 手动指定平台脚本（在 desktop/cross-platform/ 内）
bash scripts/macos/setup.sh         # macOS / Linux 全流程
powershell -ExecutionPolicy Bypass -File scripts/windows/setup.ps1   # Windows

cd desktop/cross-platform
npm run lint:fix                    # eslint + prettier 自动修复
npm test                            # hooks 单元测试
```

## 交互

| 操作 | 效果 |
|---|---|
| 悬停宠物 | 跳跃 🎉 |
| 拖动 | 移动位置（方向奔跑动画） |
| 右键 | 菜单：关闭宠物 |

## 状态优先级

`waiting > running > running-left/right > review > jumping > waving > idle > failed`

多会话同时活动时，按此顺序仲裁显示态。

## 环境要求

- macOS 13+ · [Rust](https://rustup.rs/) + Cargo · Node.js + npm · Python 3

## 完整文档

详见 [docs/reference/details.md](docs/reference/details.md)
