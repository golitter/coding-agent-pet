$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
. (Join-Path $ScriptDir "common.ps1")
$PlatformDir = Get-KotoriPlatformDir -ScriptDir $ScriptDir
$Config = Join-Path $PlatformDir "config.json"
$Example = Join-Path $PlatformDir "config.example.json"

Add-KotoriRustToPath

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
