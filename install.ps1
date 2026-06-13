# Hollycode installer (Windows) — clone-based, works without prebuilt binaries.
#   irm https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.ps1 | iex
#
# Installs Bun if missing, clones the repo to %USERPROFILE%\.hollycode,
# runs `bun install`, and drops `hollycode` + `hollycode-remote` launchers
# into Bun's bin dir (already on PATH).

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "🎬 $msg" -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host "   $msg" -ForegroundColor DarkGray }

$REPO    = "https://github.com/Davienzomq/hollywood-code"
$DEST    = Join-Path $env:USERPROFILE ".hollycode"
$BUN_BIN = Join-Path $env:USERPROFILE ".bun\bin"
$BUN_EXE = Join-Path $BUN_BIN "bun.exe"

# 1. Bun
if (-not (Test-Path $BUN_EXE)) {
    Write-Step "Installing Bun..."
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
} else {
    Write-Ok "Bun already installed."
}

# 2. Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is required. Install it from https://git-scm.com/download/win and re-run."
}

# 3. Clone or update
if (Test-Path (Join-Path $DEST ".git")) {
    Write-Step "Updating existing install at $DEST..."
    git -C $DEST pull --ff-only
} else {
    Write-Step "Cloning Hollycode to $DEST..."
    git clone --depth 1 $REPO $DEST
}

# 4. Dependencies
Write-Step "Installing dependencies (this can take a minute)..."
Push-Location $DEST
& $BUN_EXE install
Pop-Location

# 5. Launchers on PATH
Write-Step "Creating launchers in $BUN_BIN..."
New-Item -ItemType Directory -Force -Path $BUN_BIN | Out-Null

$hollycode = @"
@echo off
rem Hollycode launcher. Runs from the package dir so bunfig.toml preloads the
rem JSX runtime, and passes your current folder as the project.
set "HOLLY_PROJ=%CD%"
pushd "%USERPROFILE%\.hollycode\packages\opencode"
if "%~1"=="" (
  "%USERPROFILE%\.bun\bin\bun.exe" run --conditions=browser .\src\index.ts "%HOLLY_PROJ%"
) else (
  "%USERPROFILE%\.bun\bin\bun.exe" run --conditions=browser .\src\index.ts %*
)
popd
"@
Set-Content -Path (Join-Path $BUN_BIN "hollycode.cmd") -Value $hollycode -Encoding ASCII

$remote = @"
@echo off
rem Hollycode — Remote Control (Telegram). First run: interactive setup wizard.
set "HOLLY_PROJ=%CD%"
"%USERPROFILE%\.bun\bin\bun.exe" run "%USERPROFILE%\.hollycode\packages\telegram\bin\hollycode-remote.ts" --directory "%HOLLY_PROJ%" %*
"@
Set-Content -Path (Join-Path $BUN_BIN "hollycode-remote.cmd") -Value $remote -Encoding ASCII

Write-Host ""
Write-Host "✅ Hollycode installed!" -ForegroundColor Green
Write-Host ""
Write-Host "   cd <your project>"
Write-Host "   hollycode              " -NoNewline; Write-Host "# start coding (free models included)" -ForegroundColor DarkGray
Write-Host "   /remote-control        " -NoNewline; Write-Host "# pair your phone over Telegram" -ForegroundColor DarkGray
Write-Host ""
if (":$env:PATH:" -notlike "*$BUN_BIN*") {
    Write-Host "⚠  Open a NEW terminal so $BUN_BIN is on your PATH." -ForegroundColor Yellow
}
