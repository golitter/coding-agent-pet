$ErrorActionPreference = "Stop"

$PlatformDir = $PSScriptRoot
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
