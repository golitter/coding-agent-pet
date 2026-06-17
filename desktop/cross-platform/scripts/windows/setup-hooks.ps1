$ErrorActionPreference = "Stop"

# 脚本所在目录（scripts/windows）
if (-not $PSScriptRoot) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    $ScriptDir = $PSScriptRoot
}
# 项目根目录（cross-platform，hooks/ 与会话目录所在地）
$PlatformDir = (Get-Item $ScriptDir).Parent.Parent.FullName
if (-not $PlatformDir -or -not (Test-Path $PlatformDir)) {
    Write-Error "无法定位项目根目录（cross-platform）。ScriptDir=$ScriptDir"
}
$Script = Join-Path $PlatformDir "hooks\scripts\setup_hooks.py"

function Invoke-PythonSetup {
    param([string[]]$CommandParts)

    $exe = $CommandParts[0]
    $args = @()
    if ($CommandParts.Length -gt 1) {
        $args += $CommandParts[1..($CommandParts.Length - 1)]
    }
    $args += @($Script, $PlatformDir)

    & $exe @args
    return $LASTEXITCODE
}

$candidates = @(
    @("python"),
    @("py", "-3"),
    @("python3")
)

foreach ($candidate in $candidates) {
    $cmd = Get-Command $candidate[0] -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        continue
    }

    $code = Invoke-PythonSetup -CommandParts $candidate
    exit $code
}

Write-Error "Python 3 was not found. Install Python 3 or make python/py available on PATH."
