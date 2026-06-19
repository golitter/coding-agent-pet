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

# WSL2: 只配置 hooks/plugins，Windows 原生应用负责渲染
bash scripts/wsl/setup-hooks.sh
```

### WSL2 hooks

如果 Claude Code / Codex / OpenCode 运行在 WSL2 内，而 Kotori Pet 桌面应用运行在 Windows 原生环境，需要在对应 WSL distro 内执行：

```bash
cd <repo>/desktop/cross-platform
bash scripts/wsl/setup-hooks.sh
```

其中 `<repo>` 是本仓库在 WSL2 中看到的根目录路径。如果仓库在 Windows 的 `D:\path\to\coding-agent-pet`，WSL2 中通常对应 `/mnt/d/path/to/coding-agent-pet`。也可以在 WSL2 里先进入你 clone 的仓库根目录，再执行 `cd desktop/cross-platform`。

这个入口不会安装 npm 依赖、不会构建或启动 Tauri，只会配置当前 WSL 用户环境里的 Claude Code / Codex hooks，并在检测到 `opencode` 时部署 OpenCode 插件。事件默认推送到 Windows 渲染器监听的 `tcp://127.0.0.1:17361`。

配置步骤：

1. 先在 Windows 原生环境启动 Kotori Pet：

   ```powershell
   cd desktop\cross-platform
   powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
   ```

   已经完成初始化时，也可以只启动/重启渲染器：

   ```powershell
   cd desktop\cross-platform
   powershell -ExecutionPolicy Bypass -File scripts\windows\build-and-run.ps1
   ```

2. 打开实际运行 agent 的 WSL2 distro，进入同一份仓库并配置 hooks/plugins：

   ```bash
   cd <repo>/desktop/cross-platform
   bash scripts/wsl/setup-hooks.sh
   ```

   `<repo>` 是仓库根目录在 WSL2 中的路径。例如 Windows 路径 `D:\path\to\coding-agent-pet` 通常对应 WSL2 路径 `/mnt/d/path/to/coding-agent-pet`。

3. 查看输出结果：

   - `Configured: Claude Code` 表示 WSL 侧 Claude Code hooks 已写入 `~/.claude/settings.json`。
   - `Configured: Codex` 表示 WSL 侧 Codex hooks 已写入 `~/.codex/hooks.json`。
   - `Configured: OpenCode` 表示插件已部署到 `~/.config/opencode/plugins/`。
   - `Skipping ... command not found` 表示该工具没有安装在当前 WSL distro 内；安装后重新运行脚本即可。

4. 如果使用 Codex，首次通常还需要在 Codex 内运行 `/hooks`，对 pet hook 执行 `Trust/Enable`。

5. 之后在同一个 WSL distro 内启动 Claude Code / Codex / OpenCode。事件会通过 `tcp://127.0.0.1:17361` 推送给 Windows 端宠物。

如果脚本提示 `endpoint is not reachable right now`，通常只是 Windows 宠物尚未启动；如果已经启动仍连不上，检查 WSL 网络模式是否支持从 WSL 访问 Windows 的 `127.0.0.1`，必要时启用 WSL mirrored networking。

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
