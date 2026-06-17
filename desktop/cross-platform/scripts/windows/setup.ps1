$ErrorActionPreference = "Stop"

# 脚本所在目录（scripts/windows，用于定位同平台兄弟脚本）
# 优先用 $PSScriptRoot；个别环境下 -File 调用可能不填充它，回退到 $MyInvocation
if (-not $PSScriptRoot) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    $ScriptDir = $PSScriptRoot
}
# 项目根目录（cross-platform，共享源码 / 配置 / runtime 所在地）
# scripts/windows -> scripts -> cross-platform（上跳两层，用 .NET DirectoryInfo.Parent 避免 Split-Path 空值风险）
$PlatformDir = (Get-Item $ScriptDir).Parent.Parent.FullName
if (-not $PlatformDir -or -not (Test-Path $PlatformDir)) {
    Write-Error "无法定位项目根目录（cross-platform）。ScriptDir=$ScriptDir"
}
$Config = Join-Path $PlatformDir "config.json"
$Example = Join-Path $PlatformDir "config.example.json"

function Add-RustToPath {
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

Add-RustToPath

Write-Host "Kotori Pet Windows setup"
Write-Host ""

if (!(Test-Path $Config)) {
    if (!(Test-Path $Example)) {
        Write-Error "config.example.json not found: $Example"
    }
    Copy-Item $Example $Config
    Write-Host "Created config.json from config.example.json"
} else {
    Write-Host "Using existing config.json"
}

if (!(Test-Path (Join-Path $PlatformDir "node_modules"))) {
    Write-Host "Installing npm dependencies..."
    Push-Location $PlatformDir
    try {
        npm install
    } finally {
        Pop-Location
    }
} else {
    Write-Host "npm dependencies already installed"
}

Write-Host ""
Write-Host "Configuring hooks..."
& (Join-Path $ScriptDir "setup-hooks.ps1")

Write-Host ""
Write-Host "Building and launching..."
& (Join-Path $ScriptDir "build-and-run.ps1")

Write-Host ""
Write-Host "Setup complete."
