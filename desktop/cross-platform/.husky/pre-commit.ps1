#Requires -Version 5
# Windows 版 pre-commit（与 pre-commit 的 sh 版逻辑等价）
# 由 .husky/pre-commit 在检测到 Windows 时通过 pwsh/powershell 调用。
$ErrorActionPreference = 'Stop'

# ── 切到 cross-platform 目录（hooks 以仓库根为 cwd 运行）──
$repoRoot = & git rev-parse --show-toplevel
$cross = Join-Path $repoRoot 'desktop/cross-platform'
Set-Location $cross

# ── Frontend: Prettier + ESLint (lint-staged, only changed files) ──
& npx lint-staged
if ($LASTEXITCODE -ne 0) { exit 1 }

# ── Rust: fmt check (all files — cargo fmt has no staged-only mode) ──
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
Push-Location src-tauri
if ($cargo) {
  & cargo fmt --check --quiet 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ cargo fmt check failed. Run 'cargo fmt' in src-tauri/ to fix."
    Pop-Location
    exit 1
  }
} else {
  Write-Host "⚠️  cargo not found in PATH. Rust fmt check skipped."
}
Pop-Location

# ── Shell: shellcheck (only staged .sh files) ──
$stagedSh = & git diff --cached --name-only --diff-filter=ACM -- '*.sh' ':!node_modules'
if ($stagedSh) {
  $stagedShAbs = @($stagedSh | ForEach-Object { Join-Path $repoRoot $_ })
  $cmd = Get-Command shellcheck -ErrorAction SilentlyContinue
  if ($cmd) {
    & shellcheck @stagedShAbs
    if ($LASTEXITCODE -ne 0) { exit 1 }
  } else {
    Write-Host "⚠️  shellcheck not installed. Skipped."
  }
}

# ── Python: ruff (only staged .py files) ──
$stagedPy = & git diff --cached --name-only --diff-filter=ACM -- '*.py' ':!node_modules'
if ($stagedPy) {
  $stagedPyAbs = @($stagedPy | ForEach-Object { Join-Path $repoRoot $_ })
  $ran = $false
  foreach ($pythonName in @('python', 'python3', 'py')) {
    $py = Get-Command $pythonName -ErrorAction SilentlyContinue
    if ($py) {
      & $py.Source -m ruff --version 2>$null
      if ($LASTEXITCODE -eq 0) {
        & $py.Source -m ruff check @stagedPyAbs
        if ($LASTEXITCODE -ne 0) { exit 1 }
        $ran = $true
        break
      }
    }
  }
  if (-not $ran) {
    $ruff = Get-Command ruff -ErrorAction SilentlyContinue
    if ($ruff) {
      & $ruff.Source check @stagedPyAbs
      if ($LASTEXITCODE -ne 0) { exit 1 }
      $ran = $true
    }
  }
  if (-not $ran) {
    Write-Host "⚠️  ruff not installed. Install: pip install ruff"
  }
}
