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
│   │   ├── pet-{claude,codex}-hook.sh   # shell wrapper
│   │   └── scripts/            #   Python 实现 (common + claude_hook + codex_hook)
│   ├── runtime/sessions/       #   运行时会话状态（不入 git）
│   ├── config.example.json     #   配置模板
│   ├── setup.sh                #   全流程脚本
│   ├── build-and-run.sh        #   编译重启
│   └── setup-hooks.sh          #   单独配置 hooks
└── docs/                       # 技术文档
    ├── overview.md             #   跨平台实现概述
    ├── renderer.md             #   Tauri 渲染器详解
    ├── spritesheet.md          #   精灵图规格（55 帧）
    ├── agent-hooks/            #   Hook 协议（events / claude-code / codex）
    └── bugfix/                 #   Bugfix 计划
```

## 核心命令（在 `cross-platform/` 内执行）

```bash
cd cross-platform
./setup.sh                # 全流程
./build-and-run.sh        # 编译 + 重启
./setup-hooks.sh          # 配置 hooks
npx tauri dev             # 开发热重载
npx tauri build           # 生产构建
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
