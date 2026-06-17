# Hollycode installer (Windows) — downloads a ZIP, no git required.
#   irm https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.ps1 | iex
#
# Installs Bun if missing, downloads the repo to %USERPROFILE%\.hollycode,
# runs `bun install`, and drops `hollycode` + `hollycode-remote` launchers
# into Bun's bin dir (already on PATH).

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "🎬 $msg" -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host "   $msg" -ForegroundColor DarkGray }

$ZIP     = "https://github.com/Davienzomq/hollywood-code/archive/refs/heads/main.zip"
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
    Move-Item (Join-Path $tmp "hollywood-code-main") $DEST
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# 3. Dependencies
Write-Step "Installing dependencies (this can take a minute)..."
Push-Location $DEST
# An optional native grammar (tree-sitter-powershell) can fail to build on
# Windows without the Visual Studio C++ tools — that's only PowerShell syntax
# highlighting and is non-fatal. But that failure can leave the first install
# pass incomplete, so always run a second pass to finish linking the workspace.
& $BUN_EXE install
& $BUN_EXE install
Pop-Location

# 3b. Renamed runtime — a copy of the Bun runtime named hollycode.exe, so the
# gateway AND the opencode server it spawns (via process.execPath) both show as
# "hollycode.exe" in Task Manager instead of the generic "bun.exe".
$HOLLY_EXE = Join-Path $DEST "hollycode.exe"
Copy-Item $BUN_EXE $HOLLY_EXE -Force

# 3c. Give hollycode.exe its clapperboard icon (best-effort; uses only the
# Windows resource API — no external tools). Parses assets/hollycode.ico and
# writes RT_ICON + RT_GROUP_ICON resources into the exe.
try {
    $icoPath = Join-Path $DEST "assets\hollycode.ico"
    if (Test-Path $icoPath) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HollyRes {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string f, bool del);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint len);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool EndUpdateResource(IntPtr h, bool discard);
}
"@
        $ico = [System.IO.File]::ReadAllBytes($icoPath)
        $count = [BitConverter]::ToUInt16($ico, 4)
        $entries = @()
        for ($i = 0; $i -lt $count; $i++) {
            $o = 6 + $i * 16
            $len = [BitConverter]::ToUInt32($ico, $o + 8)
            $off = [BitConverter]::ToUInt32($ico, $o + 12)
            $img = New-Object byte[] $len
            [Array]::Copy($ico, $off, $img, 0, $len)
            $entries += [pscustomobject]@{ w = $ico[$o]; h = $ico[$o + 1]; data = $img; id = (101 + $i) }
        }
        $ms = New-Object System.IO.MemoryStream
        $bw = New-Object System.IO.BinaryWriter($ms)
        $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$count)
        foreach ($e in $entries) {
            $bw.Write([Byte]$e.w); $bw.Write([Byte]$e.h); $bw.Write([Byte]0); $bw.Write([Byte]0)
            $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$e.data.Length); $bw.Write([UInt16]$e.id)
        }
        $bw.Flush(); $grp = $ms.ToArray()
        $h = [HollyRes]::BeginUpdateResource($HOLLY_EXE, $true)
        foreach ($e in $entries) { [HollyRes]::UpdateResource($h, [IntPtr]3, [IntPtr]$e.id, 0, $e.data, [UInt32]$e.data.Length) | Out-Null }
        [HollyRes]::UpdateResource($h, [IntPtr]14, [IntPtr]1, 0, $grp, [UInt32]$grp.Length) | Out-Null
        [HollyRes]::EndUpdateResource($h, $false) | Out-Null
        Write-Ok "Applied the clapperboard icon to hollycode.exe."
    }
} catch {
    Write-Ok "Icon step skipped (optional)."
}

# 3d. Give hollycode.exe a version resource so Task Manager's Processes tab shows
# "Hollycode" (it displays the FileDescription, not the file name — without this
# the renamed Bun runtime would show as "Bun"). Best-effort, Windows API only.
try {
    $verExe = Join-Path $DEST "hollycode.exe"
    function New-VNode($key, $wType, $vlen, $val, $children) {
        $s = New-Object System.IO.MemoryStream; $w = New-Object System.IO.BinaryWriter($s)
        $w.Write([uint16]0); $w.Write([uint16]$vlen); $w.Write([uint16]$wType)
        $w.Write([System.Text.Encoding]::Unicode.GetBytes($key)); $w.Write([uint16]0); $w.Flush()
        while ($s.Length % 4 -ne 0) { $s.WriteByte(0) }
        if ($val -ne $null -and $val.Length -gt 0) { $s.Write($val, 0, $val.Length); while ($s.Length % 4 -ne 0) { $s.WriteByte(0) } }
        if ($children -ne $null -and $children.Length -gt 0) { $s.Write($children, 0, $children.Length) }
        $a = $s.ToArray(); $l = [BitConverter]::GetBytes([uint16]$a.Length); $a[0] = $l[0]; $a[1] = $l[1]; return , $a
    }
    function Join-V4($arrays) {
        $s = New-Object System.IO.MemoryStream
        foreach ($a in $arrays) { $s.Write($a, 0, $a.Length); while ($s.Length % 4 -ne 0) { $s.WriteByte(0) } }
        return , $s.ToArray()
    }
    function SV($t) { return (, ([System.Text.Encoding]::Unicode.GetBytes($t) + [byte[]]@(0, 0))) }
    $strs = @(
        (New-VNode "FileDescription" 1 10 (SV "Hollycode") $null),
        (New-VNode "ProductName" 1 10 (SV "Hollycode") $null),
        (New-VNode "FileVersion" 1 8 (SV "1.0.0.0") $null),
        (New-VNode "ProductVersion" 1 8 (SV "1.0.0.0") $null),
        (New-VNode "OriginalFilename" 1 14 (SV "hollycode.exe") $null),
        (New-VNode "InternalName" 1 10 (SV "hollycode") $null)
    )
    $st = New-VNode "040904B0" 1 0 $null (Join-V4 $strs)
    $sfi = New-VNode "StringFileInfo" 1 0 $null $st
    $vn = New-VNode "Translation" 0 4 ([byte[]]@(0x09, 0x04, 0xB0, 0x04)) $null
    $vfi = New-VNode "VarFileInfo" 1 0 $null $vn
    $ffiVals = @(0xFEEF04BDL, 0x00010000L, 0x00010000L, 0L, 0x00010000L, 0L, 0x3FL, 0L, 0x40004L, 1L, 0L, 0L, 0L)
    $fm = New-Object System.IO.MemoryStream; $fw = New-Object System.IO.BinaryWriter($fm)
    foreach ($v in $ffiVals) { $fw.Write([uint32]$v) }; $fw.Flush(); $ffi = $fm.ToArray()
    $vroot = New-VNode "VS_VERSION_INFO" 0 52 $ffi (Join-V4 @($sfi, $vfi))
    $vh = [HollyRes]::BeginUpdateResource($verExe, $false)
    [HollyRes]::UpdateResource($vh, [IntPtr]16, [IntPtr]1, 1033, $vroot, [UInt32]$vroot.Length) | Out-Null
    [HollyRes]::EndUpdateResource($vh, $false) | Out-Null
    Write-Ok "Named the runtime 'Hollycode' (Task Manager / version info)."
} catch {
    Write-Ok "Version-name step skipped (optional)."
}

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
  "%USERPROFILE%\.hollycode\hollycode.exe" run --conditions=browser .\src\index.ts "%HOLLY_PROJ%"
) else (
  "%USERPROFILE%\.hollycode\hollycode.exe" run --conditions=browser .\src\index.ts %*
)
popd
"@
Set-Content -Path (Join-Path $BUN_BIN "hollycode.cmd") -Value $hollycode -Encoding ASCII

$remote = @"
@echo off
rem Hollycode — Remote Control (multi-channel gateway). First run: setup wizard.
rem Uses the renamed runtime so the gateway + spawned server show as hollycode.exe.
set "HOLLY_PROJ=%CD%"
"%USERPROFILE%\.hollycode\hollycode.exe" run "%USERPROFILE%\.hollycode\packages\gateway\bin\hollycode-gateway.ts" --directory "%HOLLY_PROJ%" %*
"@
Set-Content -Path (Join-Path $BUN_BIN "hollycode-remote.cmd") -Value $remote -Encoding ASCII

# Update launcher — re-runs the installer to pull the latest version.
$update = @"
@echo off
rem Hollycode — update to the latest version.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.ps1 | iex"
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
