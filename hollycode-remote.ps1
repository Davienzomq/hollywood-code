param([string]$Directory = (Get-Location).Path)

$Directory = Resolve-Path $Directory
Write-Host "Connecting Telegram to: $Directory"

$old = Get-Process -Name "bun" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*telegram*" -or $_.CommandLine -like "*hollycode-remote*" }
if ($old) {
    Write-Host "Killing old bot instance..."
    $old | Stop-Process -Force
    Start-Sleep -Seconds 2
}

$cfg = Join-Path $Directory "opencode.jsonc"
if (-not (Test-Path $cfg)) {
@"
{
  "`$schema": "https://opencode.ai/config.json",
  "permission": {
    "external_directory": "allow",
    "bash": "allow",
    "read": "allow",
    "write": "allow"
  }
}
"@ | Set-Content -Path $cfg -Encoding UTF8
    Write-Host "Created opencode.jsonc"
}

$logDir = "$env:LOCALAPPDATA\hollywood\logs"
New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue | Out-Null
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = "$logDir\bot-$ts.log"
$errFile = "$logDir\bot-$ts.err"

Start-Process -NoNewWindow -FilePath "bun" -ArgumentList "run", "C:\dev\hollywood-code\packages\telegram\bin\hollycode-remote.ts", "--directory", $Directory -RedirectStandardOutput $logFile -RedirectStandardError $errFile

Write-Host "Bot started for: $Directory"
Write-Host "Open Telegram and chat with @Meuhollycodebot"
Write-Host "Logs: $logFile"
