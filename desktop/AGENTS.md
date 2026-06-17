# 🖥️ desktop/

Kotori Pet 的跨平台实现 + 技术文档目录。所有 Tauri 源码、hook 脚本、设计文档均在此。

> 技术参考详见 [../docs/reference/details.md](../docs/reference/details.md)

## 目录结构

```text
desktop/
├── cross-platform/             # Tauri 主实现
│   ├── src/                    #   前端 (HTML/CSS/JS)
│   │   ├── main.js             #     入口 + 交互绑定
│   │   ├── animator.js         #     精灵动画引擎
│   │   ├── bubble.js           #     对话气泡
│   │   └── style.css           #     全局样式
│   ├── src-tauri/              #   后端 (Rust)
│   │   └── src/                #     main/lib/config/commands/aggregator/watcher
│   ├── hooks/                  #   Hook 脚本
│   │   ├── pet-hook.sh                 # shell wrapper (claude-code / codex)
│   │   ├── opencode-plugin.ts          # OpenCode 插件（TS，进程内运行，由 setup-hooks.sh 部署到 ~/.config/opencode/plugins/）
│   │   ├── opencode-shared.mjs         # OpenCode 共享逻辑（repo root 检测 / 事件映射 / payload / IO）
│   │   └── scripts/            #   Python 实现 (common + claude_hook + codex_hook + setup_hooks + test_hooks)
│   ├── runtime/sessions/       #   运行时会话状态（不入 git）
│   ├── config.example.json     #   配置模板
│   └── scripts/                #   平台入口脚本（按 OS 分目录）
│       ├── macos/              #     setup.sh / build-and-run.sh / setup-hooks.sh
│       └── windows/            #     setup.ps1 / build-and-run.ps1 / setup-hooks.ps1
└── docs/                       # 技术文档（按主题分目录）
    ├── reference/              #   技术参考（overview / renderer / spritesheet）
    ├── agent-hooks/            #   Hook 集成（events / claude-code / codex / opencode）
    ├── design/                 #   设计文档（功能设计 + 重构方案）
    └── bugfix/                 #   Bugfix 记录（问题分析 + 修复方案）
```

## 核心命令（在 `cross-platform/` 内执行）

```bash
cd cross-platform

# macOS / Linux
./scripts/macos/setup.sh          # 全流程
./scripts/macos/build-and-run.sh  # 编译 + 重启
./scripts/macos/setup-hooks.sh    # 配置 hooks

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File scripts/windows/setup.ps1

npm run dev               # 开发热重载（tauri dev）
npm run build             # 生产构建（tauri build）
npm run lint:fix          # eslint + prettier 自动修复
```

## 日志

```bash
RUST_LOG=debug ./src-tauri/target/debug/kotori-pet   # 详细
RUST_LOG=warn  ./src-tauri/target/debug/kotori-pet   # 仅警告
tail -f /tmp/kotori-pet-tauri.log                    # 渲染器后台日志
```

## 完整文档

详见 [../docs/reference/details.md](../docs/reference/details.md)

## docs/ 分类规范

新增文档按主题归入子目录，不放松散文件：`reference/`（技术规格）、`agent-hooks/`（Hook 集成）、`design/`（设计方案）、`bugfix/`（Bug 记录）。不确定时放 `reference/`。
