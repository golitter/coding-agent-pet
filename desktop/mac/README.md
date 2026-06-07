# 🐦 Kotori 虚拟桌面宠物 (macOS)

一只浮在桌面上的像素风南小鸟，会根据你的 AI 编码工具（Claude Code / Codex）的状态切换动画和对话。

## 安装

```bash
git clone <repo> ~/pet
cd ~/pet
./desktop/mac/setup.sh
```

一条命令搞定：生成配置 → 注册 hooks → 编译 → 启动。

## 使用

| 操作 | 效果 |
|---|---|
| 点击宠物 | 触发跳跃动画 🎉 |
| 拖动宠物 | 移动位置，宠物会跑起来 |
| 右键宠物 | 菜单：打开 Codex / VS Code / 关闭宠物 |
| 正常使用 Claude Code 或 Codex | 宠物自动反应工作状态 |

## 动画状态

| 场景 | 动画 | 气泡台词 |
|---|---|---|
| 点击宠物 | 跳跃 🎉 | — |
| 启动会话 | 挥手 👋 | 嗨！小鸟来啦～ |
| 执行工具 | 奔跑 🏃 | 执行中... |
| 读取/编辑代码 | 审阅 📖 | 让我看看... / 改好啦～ |
| 任务完成 | 跳跃 🎉 | 搞定啦！✨ |
| 需要授权 | 等待 ⚠️ | 需要你的授权～ |
| 出错 | 失败 💔 | 呜...出了点问题 |
| 拖动宠物 | 方向奔跑 →← | — |

## 配置

编辑 `config.json` 自定义：

```json
{
  "renderer": { "scale": 0.6, "fps": 10 },
  "state_map": { "Stop": {"state": "jumping", "dialogue": "搞定啦！✨"} },
  "menu": { "items": [...] }
}
```

路径留 `null` 自动检测，无需手动填写。详见 [config.example.json](config.example.json)。

修改后运行 `./build-and-run.sh` 重启生效。

## 目录结构

```
desktop/mac/
├── config.example.json   # 配置模板
├── config.json           # 你的配置（自动生成）
├── setup.sh              # 一键安装
├── build-and-run.sh      # 编译并重启
├── setup-hooks.sh        # 配置 hooks
├── hooks/                # Hook 脚本
├── renderer/             # Swift 渲染器源码
└── runtime/sessions/     # 运行时状态
```

## 要求

- macOS 13+
- Xcode Command Line Tools (`xcode-select --install`)
- Python 3（系统自带）
