# Installs free, local speech-to-text (whisper.cpp + a multilingual model) and
# ffmpeg (to convert Telegram's Ogg/Opus to 16 kHz WAV) into
# %USERPROFILE%\.hollycode. With this, the bot understands voice notes with NO
# API key. Bundled by the main installer; can be run standalone.
$ErrorActionPreference = "Stop"
$whisper = Join-Path $env:USERPROFILE ".hollycode\whisper"
$ff = Join-Path $env:USERPROFILE ".hollycode\ffmpeg"
New-Item -ItemType Directory -Force $whisper, $ff | Out-Null

function Get-Zip($url, $dest) {
  $z = Join-Path $env:TEMP ("dl-" + [guid]::NewGuid().ToString("N") + ".zip")
  Invoke-WebRequest -Uri $url -OutFile $z -UseBasicParsing
  $t = Join-Path $env:TEMP ("ex-" + [guid]::NewGuid().ToString("N"))
  Expand-Archive -Path $z -DestinationPath $t -Force
  Remove-Item $z -ErrorAction SilentlyContinue
  return $t
}

Write-Host "Downloading whisper.cpp binary..."
$t1 = Get-Zip "https://github.com/ggerganov/whisper.cpp/releases/download/v1.5.4/whisper-bin-x64.zip" $whisper
# the zip has main.exe + dlls (possibly under a subfolder) — copy them all in
Get-ChildItem -Recurse $t1 -Include *.exe, *.dll | ForEach-Object { Copy-Item -Force $_.FullName $whisper }
Remove-Item -Recurse -Force $t1 -ErrorAction SilentlyContinue

Write-Host "Downloading whisper model (ggml-medium, multilingual ~1.5GB — accurate)..."
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin" -OutFile (Join-Path $whisper "model.bin") -UseBasicParsing

Write-Host "Downloading ffmpeg..."
$t2 = Get-Zip "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" $ff
$ffexe = Get-ChildItem -Recurse $t2 -Filter "ffmpeg.exe" | Select-Object -First 1
if ($ffexe) { Copy-Item -Force $ffexe.FullName (Join-Path $ff "ffmpeg.exe") }
Remove-Item -Recurse -Force $t2 -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Local speech-to-text installed:" -ForegroundColor Green
Write-Host "  whisper: $whisper"
Write-Host "  ffmpeg:  $ff"
Write-Host "Voice notes now work offline with no API key."
