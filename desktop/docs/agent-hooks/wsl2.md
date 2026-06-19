# WSL2 Hooks → Windows 宠物渲染器

这个配置适用于 Windows + WSL2 分离运行的工作流：

- Kotori Pet 桌面宠物运行在 Windows 原生环境。
- Claude Code / Codex / OpenCode 运行在 WSL2 内。
- WSL2 内的 hooks 和 OpenCode 插件通过 `tcp://127.0.0.1:17361` 把事件推送给 Windows 渲染器。

## 配置方法

先启动 Windows 端 Kotori Pet，然后在 WSL2 里进入仓库并运行：

```bash
cd <repo>/desktop/cross-platform
bash scripts/wsl/setup-hooks.sh
```

其中 `<repo>` 是本仓库在 WSL2 中看到的根目录路径。它不是 Windows 里的 `D:\...` 路径。

常见取得方式：

- 仓库在 Windows 盘时，把盘符映射到 `/mnt/<盘符小写>/`。例如 `D:\path\to\coding-agent-pet` 通常对应 `/mnt/d/path/to/coding-agent-pet`。
- 已经在 WSL2 里进入仓库根目录时，运行 `pwd` 查看路径，然后执行 `cd desktop/cross-platform`。
- 仓库直接 clone 在 WSL2 的 Linux 文件系统内时，`<repo>` 可能类似 `~/coding-agent-pet` 或 `/home/<user>/coding-agent-pet`。

这个脚本只会配置 WSL 用户环境里的 agent hooks / 插件，不会安装 npm 依赖、不会构建 Tauri，也不会启动桌面宠物。

脚本还会非阻断地检查一次 `127.0.0.1:17361` 是否可连接。检查失败时仍会继续配置，因为 Windows 宠物可能只是尚未启动。如果宠物已经启动但仍然连不上，通常需要启用 WSL mirrored networking，或显式配置一个 WSL 可以访问到的事件端点。

## 会写入什么

WSL 入口会调用共享的 hook 安装器，并启用 WSL 检测。在 WSL 内，Claude Code / Codex 会写入直接执行 Python 脚本的命令，而不是使用 shell wrapper：

```bash
python3 /mnt/d/.../desktop/cross-platform/hooks/scripts/claude_hook.py
python3 /mnt/d/.../desktop/cross-platform/hooks/scripts/codex_hook.py
```

这些命令会写入 WSL 侧的配置文件：

- `~/.claude/settings.json`
- `~/.codex/hooks.json`

如果 WSL 内可以找到 `opencode` 命令，安装器还会把 OpenCode 插件部署到：

```text
~/.config/opencode/plugins/
```

包括：

- `pet-plugin.ts`
- `opencode-shared.mjs`
- `.kotori-pet-config-dir`

Codex 首次使用时可能仍需要在 `/hooks` 里手动 Trust/Enable 一次。

脚本输出里常见状态含义：

- `Configured: Claude Code`：已写入 WSL 侧 `~/.claude/settings.json`。
- `Configured: Codex`：已写入 WSL 侧 `~/.codex/hooks.json`。
- `Configured: OpenCode`：已部署 WSL 侧 OpenCode 插件。
- `Skipping ... command not found`：当前 WSL distro 内没有安装对应 CLI；安装后重新运行脚本即可。

## 运行时路径

运行时，Python hook 脚本和 OpenCode shared runtime 都会检测 WSL 环境，并默认使用：

```text
tcp://127.0.0.1:17361
```

Windows 原生宠物使用相同的默认端点，因此通常不需要额外做 socket 路径映射。

如果需要覆盖默认端点，可以在 `desktop/cross-platform/config.json` 中设置 `event_endpoint`。Windows 端渲染器和 WSL2 hooks/plugins 必须使用同一个端点，否则 WSL2 内的事件会发不到 Windows 宠物。

## 环境要求

- WSL2 内可用 `python3`。
- Claude Code、Codex、OpenCode 安装在执行 setup 脚本的同一个 WSL distro 中；未安装的工具会被跳过。
- hook / plugin 事件触发前，Windows 端 Kotori Pet 已经启动。

如果不想使用默认的 `python3` 命令，可以在运行 setup 前设置 `KOTORI_PET_PYTHON`：

```bash
KOTORI_PET_PYTHON=/usr/bin/python3 bash scripts/wsl/setup-hooks.sh
```

如果只想临时跳过 OpenCode 插件部署，可以设置：

```bash
KOTORI_PET_SKIP_OPENCODE=1 bash scripts/wsl/setup-hooks.sh
```

## 排障

- 看到 `endpoint is not reachable right now`：通常只是 Windows 端宠物还没有启动；脚本仍会继续写配置。
- Windows 端宠物已启动但仍无法收到事件：确认 WSL2 能访问 Windows 的 `127.0.0.1:17361`，必要时启用 WSL mirrored networking，或把 `event_endpoint` 改成 WSL 能访问的地址。
- Codex 没有触发宠物：在 Codex 内运行 `/hooks`，确认 pet hook 已 Trust/Enable。
- OpenCode 没有触发宠物：确认 `opencode` 安装在同一个 WSL distro 内，并检查 `~/.config/opencode/plugins/` 下是否存在 `pet-plugin.ts`、`opencode-shared.mjs` 和 `.kotori-pet-config-dir`。
