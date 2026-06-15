# Installs the free, local Piper TTS engine + a default voice into
# %USERPROFILE%\.hollycode\piper so Hollycode can speak replies offline,
# with no API key. Bundled by the main installer; can be run standalone.
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE ".hollycode\piper"
New-Item -ItemType Directory -Force $dir | Out-Null

$bin = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip"
# pt-BR neural voice (Faber, medium) — change for another language if you like.
$onnx = "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx?download=true"
$json = "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx.json?download=true"

Write-Host "Downloading Piper binary..."
$zip = Join-Path $env:TEMP "piper.zip"
Invoke-WebRequest -Uri $bin -OutFile $zip -UseBasicParsing
$tmp = Join-Path $env:TEMP ("piper-" + [guid]::NewGuid().ToString("N"))
Expand-Archive -Path $zip -DestinationPath $tmp -Force
# the zip contains a top-level "piper" folder — flatten it into $dir
$inner = Join-Path $tmp "piper"
Copy-Item -Recurse -Force (Join-Path $inner "*") $dir
Remove-Item -Recurse -Force $tmp, $zip -ErrorAction SilentlyContinue

Write-Host "Downloading voice model (pt-BR)..."
Invoke-WebRequest -Uri $onnx -OutFile (Join-Path $dir "voice.onnx") -UseBasicParsing
Invoke-WebRequest -Uri $json -OutFile (Join-Path $dir "voice.onnx.json") -UseBasicParsing

Write-Host ""
Write-Host "Piper installed to $dir" -ForegroundColor Green
Write-Host "Voice replies are now free & offline. Turn on with /voice on in the gateway."
