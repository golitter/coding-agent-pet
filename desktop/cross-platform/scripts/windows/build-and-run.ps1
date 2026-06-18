$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
. (Join-Path $ScriptDir "common.ps1")
$PlatformDir = Get-KotoriPlatformDir -ScriptDir $ScriptDir
$TauriDir = Join-Path $PlatformDir "src-tauri"
$Binary = Join-Path $TauriDir "target\debug\kotori-pet.exe"
$RuntimeDir = Join-Path $PlatformDir "runtime"
$SessionsDir = Join-Path $RuntimeDir "sessions"
$LogFile = Join-Path $RuntimeDir "kotori-pet-tauri.log"
$ErrLogFile = Join-Path $RuntimeDir "kotori-pet-tauri.err.log"
$PidFile = Join-Path $RuntimeDir "kotori-pet.pid"

Add-KotoriRustToPath
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($null -eq $cargo) {
    Write-Error "cargo was not found. Install Rust with rustup, or add %USERPROFILE%\.cargo\bin to PATH."
}

Write-Host "Building KotoriPet (Tauri)..."
Push-Location $PlatformDir
$buildFailed = $false
try {
    npx tauri build --debug
    if ($LASTEXITCODE -ne 0) {
        $buildFailed = $true
    }
} finally {
    Pop-Location
}

if ($buildFailed) {
    Write-Error "tauri build failed (exit code non-zero). Aborting before launching a stale binary. See output above."
}

New-Item -ItemType Directory -Force -Path $SessionsDir | Out-Null

if (Test-Path $PidFile) {
    $oldPidText = Get-Content -Raw $PidFile
    $oldPid = 0
    if ([int]::TryParse($oldPidText.Trim(), [ref]$oldPid)) {
        $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($null -ne $oldProc) {
            Write-Host "Stopping previous KotoriPet process (PID: $oldPid)..."
            Stop-Process -Id $oldPid -Force
            Start-Sleep -Milliseconds 500
        }
    }
}

if (!(Test-Path $Binary)) {
    Write-Error "Built binary not found: $Binary"
}

Write-Host "Starting KotoriPet..."
$proc = Start-Process -FilePath $Binary -WorkingDirectory $PlatformDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError $ErrLogFile

Set-Content -Path $PidFile -Value $proc.Id
Start-Sleep -Seconds 2

$running = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($null -eq $running) {
    Write-Error "KotoriPet failed to start. See logs: $LogFile and $ErrLogFile"
}

Write-Host "KotoriPet started (PID: $($proc.Id))"
