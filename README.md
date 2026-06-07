# 🐦 Kotori Pet

一只住在 macOS 桌面上的小鸟 — 南琴梨（Kotori Minami）像素风格桌面宠物。她跟随 AI 编程工具（Claude Code / Codex）的状态变化做出反应。

## 快速开始

```bash
cd desktop/mac
cp config.example.json config.json   # 按需修改配置
./setup.sh                           # 一键安装 & 启动
```

## 架构

```
Claude Code / Codex → JSON 事件 (hooks) → session 文件 → Unix Socket → Swift 渲染器
```

支持多会话同时运行，按优先级聚合状态。

## 内置Codex 中使用

通过 Codex Skill 自动生成宠物素材，详见 [教程文档](docs/codex实现虚拟宠物.md)。

## License

MIT
