# Hooks 脚本去冗余 — 设计文档

## 背景

`desktop/cross-platform/hooks/` 中 Claude Code 和 Codex 两套 hook 脚本存在冗余：

- **Shell 脚本** `pet-claude-hook.sh` 与 `pet-codex-hook.sh` 97% 相同（仅目标 .py 文件名不同）
- **Python 入口** `claude_hook.py` 与 `codex_hook.py` 业务逻辑差异大（字段提取方式、EVENT_ALIASES、stdout 输出行为均不同），但模板代码重复（imports、stdin 读取）

目标：消除冗余，保持各自业务逻辑独立。

## 方案

### 1. 合并 Shell → `pet-hook.sh`

两个 shell wrapper 合并为一个，通过参数分发到不同 Python 脚本：

```bash
#!/bin/bash
# Kotori Minami pet state hook (Claude Code / Codex)
# Usage: pet-hook.sh <claude-code|codex>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="${1:-claude-code}"

case "$SOURCE" in
    claude-code) /usr/bin/python3 "$SCRIPT_DIR/scripts/claude_hook.py" || true ;;
    codex)       /usr/bin/python3 "$SCRIPT_DIR/scripts/codex_hook.py" || true ;;
    *)           echo "Unknown source: $SOURCE" >&2; exit 1 ;;
esac
```

> **行为说明**：不使用 `exec`，保留原始的 `|| true` 确保 hook 失败不阻塞 Claude Code / Codex。原始脚本用的是 `|| true`（永远返回 0），`exec` 会直接透传 Python 退出码，改变了容错语义。虽然 Python 内部已 catch-all `sys.exit(0)`，但保留 shell 层的 `|| true` 作为双重保险。

**调用方**：`setup-hooks.sh` 中 Claude Code 注册 `pet-hook.sh claude-code`，Codex 注册 `pet-hook.sh codex`。

### 2. 提取 Python 公共模板到 `common.py`

在 `common.py` 中新增一个工具函数 `read_stdin_json`：

```python
def read_stdin_json():
    """读取 stdin JSON，失败时静默退出。"""
    try:
        return json.load(sys.stdin)
    except Exception:
        sys.exit(0)
```

> **设计决策**：`resolve_platform_dir` **不提取**。`str(Path(__file__).resolve().parent.parent.parent)` 只有 1 行，提取成函数后仍需 import + 调用（2 行），且两个入口各只调用一次，收益为零。保留原地写法。实际可消除的重复只有 stdin 读取的 try/except（约 4 行）。

> **Codex stdout `{}` 行为**：`read_stdin_json` 只处理 stdin 读取层，**不负责** Codex 的 stdout 输出。Codex 的 `print('{}')` 出现在两个位置：
> 1. stdin 解析失败时 → 保留在 `codex_hook.py` 的调用方处理
> 2. 正常处理完成后（末尾）→ 保留在 `codex_hook.py` 的 `main()` 末尾
>
> 这是 Codex hook 协议要求（command hooks 需返回 JSON-ish stdout），属于 Codex 的业务逻辑，不应被抽象吞掉。

### 3. 精简 Python 入口

两个 Python 入口保留各自的业务逻辑，仅替换 stdin 读取模板：

**`claude_hook.py` 精简后**：

```python
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import process_event, read_stdin_json

def main():
    platform_dir = str(Path(__file__).resolve().parent.parent.parent)
    input_data = read_stdin_json()

    # Claude Code 字段提取（保持原样）
    hook_event = input_data.get('hook_event_name', '') or ''
    session_id = input_data.get('session_id', 'unknown') or 'unknown'
    tool_name  = input_data.get('tool_name', '') or ''
    cwd        = input_data.get('cwd', '') or ''

    process_event(
        platform_dir=platform_dir,
        source='claude-code',
        hook_event=hook_event,
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
    )
```

**`codex_hook.py` 精简后**：

```python
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import process_event  # 不引入 read_stdin_json

EVENT_ALIASES = { ... }  # 保持原样

def main():
    platform_dir = str(Path(__file__).resolve().parent.parent.parent)

    # Codex stdin 失败时需输出 {}（协议要求），不能直接用 read_stdin_json()
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        print('{}')
        sys.exit(0)

    # Codex 字段提取（保持原样，多字段 fallback）
    ...

    process_event(
        platform_dir=platform_dir,
        source='codex',
        hook_event=hook_event,
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
        extra_context={'raw_event': raw_event},
        log_path='/tmp/kotori-pet-codex-hook.log',
    )

    # Codex command hooks expect JSON-ish stdout
    print('{}')
```

> **关键**：`codex_hook.py` **不使用** `read_stdin_json()`，因为 Codex 协议要求 stdin 失败时也必须输出 `{}`。末尾的 `print('{}')` 同样必须保留。两处 `{}` 输出都属于 Codex 特有逻辑，不抽象到公共层。
>
> 因此 `codex_hook.py` 实际只复用 `common.process_event`，不引入 `read_stdin_json`，模板行数不变。

### 4. 更新 `setup-hooks.sh`

**变量变更**（setup-hooks.sh:37-38）：

```python
# 旧
claude_hook  = os.path.join(hook_dir, 'pet-claude-hook.sh')
codex_hook   = os.path.join(hook_dir, 'pet-codex-hook.sh')

# 新
hook_script  = os.path.join(hook_dir, 'pet-hook.sh')
claude_hook  = f'{hook_script} claude-code'
codex_hook   = f'{hook_script} codex'
```

`setup_platform()` 内部用 `hook_cmd` 直接写入 `command` 字段，带参数的命令字符串 JSON 序列化后仍能正确执行。

**`OLD_PATHS` 增量**（在现有列表末尾追加）：

```python
OLD_PATHS = [
    'kotori-desktop-pet/hooks/pet-claude-hook.sh',      # 保留
    'kotori-desktop-pet/hooks/pet-codex-hook.sh',       # 保留
    'desktop/mac/hooks/pet-claude-hook.sh',             # 保留
    'desktop/mac/hooks/pet-codex-hook.sh',              # 保留
    'hooks/pet-claude-hook.sh',                         # 新增
    'hooks/pet-codex-hook.sh',                          # 新增
]
```

### 5. 删除旧 Shell 文件

- `hooks/pet-claude-hook.sh`
- `hooks/pet-codex-hook.sh`

（`claude_hook.py` / `codex_hook.py` / `common.py` / `ruff.toml` 保留）

### 6. 更新文档

以下文件引用了旧文件名，需同步更新：

| 文件 | 涉及内容 |
|---|---|
| `AGENTS.md`（根 + desktop） | 目录结构中的 shell 文件名 |
| `desktop/docs/reference/overview.md` | 目录结构图、ASCII 架构图 |
| `desktop/docs/agent-hooks/README.md` | Hook 入口对照表 |
| `desktop/docs/agent-hooks/claude-code.md` | 配置示例中的 command 路径 |
| `desktop/docs/agent-hooks/codex.md` | 配置示例中的 command 路径 |
| `desktop/docs/agent-hooks/events.md` | 引用说明 |
| `docs/reference/details.md` | 文件列表表格 |

## 文件变更汇总

| 操作 | 文件 |
|---|---|
| 新建 | `hooks/pet-hook.sh` |
| 修改 | `hooks/scripts/common.py`（+1 工具函数 `read_stdin_json`） |
| 修改 | `hooks/scripts/claude_hook.py`（使用 `read_stdin_json` 替换 try/except） |
| 修改 | `hooks/scripts/codex_hook.py`（stdin try/except 保留不动，仅删多余 import） |
| 修改 | `setup-hooks.sh`（变量名 + 命令参数 + OLD_PATHS） |
| 修改 | 文档 7 处 |
| 删除 | `hooks/pet-claude-hook.sh` |
| 删除 | `hooks/pet-codex-hook.sh` |

## 验证

1. `ruff check hooks/scripts/` — 确认 `common.py` 新增函数无 lint 误报
2. `bash -n hooks/pet-hook.sh` — shell 语法检查
3. `echo '{"hook_event_name":"PreToolUse","session_id":"test","tool_name":"Bash"}' | python3 hooks/scripts/claude_hook.py` — Claude 入口
4. `echo '{"event":"pre_tool_use","session_id":"test","tool":"Bash"}' | python3 hooks/scripts/codex_hook.py` — Codex 入口（验证末尾输出 `{}`）
5. `./setup-hooks.sh` — 后检查 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 的 command 路径含正确参数
