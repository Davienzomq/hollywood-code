# Hollycode installer (Windows) — downloads a ZIP, no git required.
#   irm https://raw.githubusercontent.com/Davienzomq/hollywood-code/dev/install.ps1 | iex
#
# Installs Bun if missing, downloads the repo to %USERPROFILE%\.hollycode,
# runs `bun install`, and drops `hollycode` + `hollycode-remote` launchers
# into Bun's bin dir (already on PATH).

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "🎬 $msg" -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host "   $msg" -ForegroundColor DarkGray }

$ZIP     = "https://github.com/Davienzomq/hollywood-code/archive/refs/heads/dev.zip"
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

# 2. Download + extract (replaces any previous install)
Write-Step "Downloading Hollycode..."
$tmp = Join-Path $env:TEMP ("hollycode-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    Invoke-WebRequest -Uri $ZIP -OutFile (Join-Path $tmp "repo.zip") -UseBasicParsing
    Write-Step "Extracting to $DEST..."
    Expand-Archive -Path (Join-Path $tmp "repo.zip") -DestinationPath $tmp -Force
    if (Test-Path $DEST) { Remove-Item -Recurse -Force $DEST }
    Move-Item (Join-Path $tmp "hollywood-code-dev") $DEST
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# 3. Dependencies
Write-Step "Installing dependencies (this can take a minute)..."
Push-Location $DEST
& $BUN_EXE install
Pop-Location

# 4. Launchers on PATH
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
rem Hollycode — Remote Control (multi-channel gateway). First run: setup wizard.
set "HOLLY_PROJ=%CD%"
"%USERPROFILE%\.bun\bin\bun.exe" run "%USERPROFILE%\.hollycode\packages\gateway\bin\hollycode-gateway.ts" --directory "%HOLLY_PROJ%" %*
"@
Set-Content -Path (Join-Path $BUN_BIN "hollycode-remote.cmd") -Value $remote -Encoding ASCII

# Update launcher — re-runs the installer to pull the latest version.
$update = @"
@echo off
rem Hollycode — update to the latest version.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Davienzomq/hollywood-code/dev/install.ps1 | iex"
"@
Set-Content -Path (Join-Path $BUN_BIN "hollycode-update.cmd") -Value $update -Encoding ASCII

# Uninstall launcher — stops the gateway, removes auto-start, deletes the install
# and the launchers. Bun is left installed (other tools may use it).
$uninstall = @"
@echo off
rem Hollycode — uninstall.
echo Removing Hollycode...
"%USERPROFILE%\.bun\bin\bun.exe" run "%USERPROFILE%\.hollycode\packages\gateway\bin\hollycode-gateway.ts" --remove-startup 2>nul
"%USERPROFILE%\.bun\bin\bun.exe" run "%USERPROFILE%\.hollycode\packages\gateway\bin\hollycode-gateway.ts" --stop 2>nul
powershell -NoProfile -Command "Remove-Item -Recurse -Force '%USERPROFILE%\.hollycode' -ErrorAction SilentlyContinue"
del "%USERPROFILE%\.bun\bin\hollycode.cmd" 2>nul
del "%USERPROFILE%\.bun\bin\hollycode-remote.cmd" 2>nul
del "%USERPROFILE%\.bun\bin\hollycode-update.cmd" 2>nul
echo Hollycode uninstalled. (Bun was left installed.)
del "%USERPROFILE%\.bun\bin\hollycode-uninstall.cmd" 2>nul
"@
Set-Content -Path (Join-Path $BUN_BIN "hollycode-uninstall.cmd") -Value $uninstall -Encoding ASCII

# 6. Free local voice (Piper) — best-effort, never fails the install.
Write-Step "Installing free local voice (Piper)..."
try {
    & (Join-Path $DEST "scripts\install-piper.ps1")
} catch {
    Write-Ok "Piper voice skipped (optional) — you can run scripts\install-piper.ps1 later."
}

# 7. Native browser tool (Playwright MCP) — pre-download Chromium, best-effort.
# The browser tool is on by default; the MCP server installs on first use, but
# pre-fetching the browser here makes that first use instant.
Write-Step "Preparing the native browser tool (Playwright)..."
try {
    & npx -y playwright@latest install chromium 2>$null
    Write-Ok "Browser tool ready (toggle with /tools)."
} catch {
    Write-Ok "Browser tool will download on first use — no action needed."
}

Write-Host ""
Write-Host "✅ Hollycode installed!" -ForegroundColor Green
Write-Host ""
Write-Host "   cd <your project>"
Write-Host "   hollycode              " -NoNewline; Write-Host "# start coding (free models included)" -ForegroundColor DarkGray
Write-Host "   hollycode-remote       " -NoNewline; Write-Host "# pair your phone (Telegram, Discord, …)" -ForegroundColor DarkGray
Write-Host "   hollycode-update       " -NoNewline; Write-Host "# update to the latest version" -ForegroundColor DarkGray
Write-Host "   hollycode-uninstall    " -NoNewline; Write-Host "# remove Hollycode" -ForegroundColor DarkGray
Write-Host ""
if (":$env:PATH:" -notlike "*$BUN_BIN*") {
    Write-Host "⚠  Open a NEW terminal so $BUN_BIN is on your PATH." -ForegroundColor Yellow
}
