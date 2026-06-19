# pre-commit staged 文件路径错误

## 问题

Windows pre-commit 可以被触发，但在检查 staged Python 文件时失败：

```text
E902 系统找不到指定的路径
```

典型路径形态是：

```text
desktop/cross-platform/hooks/scripts/setup_hooks.py
```

## 根因

`.husky/pre-commit.ps1` 和 `.husky/pre-commit` 都会先切到：

```text
desktop/cross-platform
```

但 `git diff --cached --name-only` 返回的 staged 文件路径仍可能是仓库根相对路径。脚本把这些路径原样传给 `ruff` / `shellcheck`，工具就会在 `desktop/cross-platform` 下寻找：

```text
desktop/cross-platform/desktop/cross-platform/hooks/scripts/setup_hooks.py
```

因此报找不到文件。

PowerShell 版还有一个环境兼容问题：当前机器上 `python -m ruff` 不可用，但 `py -m ruff` 可用；旧脚本没有尝试 `py`，会误报 ruff 未安装。

## 修复

- 在 sh 和 PowerShell 两版 pre-commit 中，把 staged 文件统一转换为 `$repoRoot` / `$repo_root` 下的绝对路径，再传给 `shellcheck` 和 `ruff`。
- sh 版 `lint-staged` 失败后立即 `exit 1`，避免后续检查覆盖失败状态。
- PowerShell 版 ruff 探测顺序改为 `python` → `python3` → `py` → `ruff`。
- sh 版 ruff fallback 改为 `python3 -m ruff` → `python -m ruff` → `ruff`，移除不可用的 `npx ruff`。

## 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\cross-platform\.husky\pre-commit.ps1
py -m ruff check D:\path\to\repo\desktop\cross-platform\hooks\scripts\setup_hooks.py
```

```bash
bash -n desktop/cross-platform/.husky/pre-commit
bash -n desktop/cross-platform/scripts/wsl/setup-hooks.sh
```

项目测试：

```bash
cd desktop/cross-platform
npm test
```
