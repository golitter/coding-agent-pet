# 🖥️ desktop/

Kotori Pet 的跨平台实现目录。包含 Tauri 主实现（源码 / Hook / 平台入口脚本）。

> 顶层一键入口见仓库根目录 [`../README.md`](../README.md) 的 `python setup.py`。
> 本文记录手动指定平台脚本、入口脚本目录结构、hooks 自动安装细节等进阶说明。

## 手动指定平台脚本

如果不想用根目录的 `python setup.py`，可以手动进入目录、直接调用对应平台的入口脚本：

```bash
cd cross-platform
cp config.example.json config.json   # 按需修改

# macOS / Linux
bash scripts/macos/setup.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File scripts/windows/setup.ps1
```

## 入口脚本目录结构

入口脚本按平台分目录，源码 `src/`、`src-tauri/`、`hooks/`、配置等保持单份共享：

- `scripts/macos/`：`setup.sh` / `setup-hooks.sh` / `build-and-run.sh`
- `scripts/windows/`：对应 `.ps1`（`setup.ps1` / `setup-hooks.ps1` / `build-and-run.ps1`）

## hooks 自动安装

`setup.sh` / `setup.ps1` 会自动安装 Claude Code / Codex / OpenCode 三套 hooks 集成；重复执行不会重复追加。
其中 Codex 会自动写入 hook，并尽量启用已有 trust 记录的条目，但首次使用通常仍需要在 `/hooks` 里手动 `Trust/Enable` 一次。

## setup vs build-and-run

- **日常首次安装、换机、完整更新** → 始终使用 `setup.sh` / `setup.ps1`（全流程）。
- **已完成初始化后的开发态增量重启** → `build-and-run.sh` / `build-and-run.ps1`。

## 完整文档

详见 [../docs/reference/details.md](../docs/reference/details.md)。
