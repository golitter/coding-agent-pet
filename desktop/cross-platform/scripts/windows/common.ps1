$ErrorActionPreference = "Stop"

function Get-KotoriPlatformDir {
    param([string]$ScriptDir)

    $platformDir = (Get-Item $ScriptDir).Parent.Parent.FullName
    if (-not $platformDir -or -not (Test-Path $platformDir)) {
        Write-Error "Cannot locate cross-platform directory. ScriptDir=$ScriptDir"
    }
    return $platformDir
}

function Add-KotoriRustToPath {
    $paths = @(
        (Join-Path $env:USERPROFILE ".cargo\bin"),
        (Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-msvc\bin")
    )

    foreach ($path in $paths) {
        if ((Test-Path $path) -and ($env:Path -notlike "*$path*")) {
            $env:Path = "$path;$env:Path"
        }
    }
}
