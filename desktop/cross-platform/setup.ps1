$ErrorActionPreference = "Stop"

$PlatformDir = $PSScriptRoot
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
& (Join-Path $PlatformDir "setup-hooks.ps1")

Write-Host ""
Write-Host "Building and launching..."
& (Join-Path $PlatformDir "build-and-run.ps1")

Write-Host ""
Write-Host "Setup complete."
