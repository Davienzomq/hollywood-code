---
name: youtube-transcribe
description: "Transcribe and understand a YouTube video from its link. Pull the captions/subtitles with yt-dlp, clean them into readable text, then summarize or answer the user's question about the content (step-by-step instructions, key points, quotes with timestamps). TRIGGER whenever the user sends a YouTube URL (youtube.com/watch, youtu.be/, youtube.com/shorts) or asks to transcribe, summarize, or explain a YouTube video."
version: 1.0.0
author: Hollycode
license: MIT
metadata:
  hollycode:
    tags: [youtube, transcription, video, captions, summarize, research]
prerequisites:
  commands: [python]
---

# YouTube Transcribe

You cannot watch a video's frames or hear its audio. But you CAN read its
**captions/subtitles** — which contain everything the speaker says. Use this to
transcribe and understand any YouTube video the user links.

## When to use

- The user sends a YouTube link (`youtube.com/watch?v=...`, `youtu.be/...`, `youtube.com/shorts/...`).
- The user asks to transcribe / summarize / explain / "what does this video say" / "follow the steps in this video".

## Steps (run with the terminal + file tools)

### 1. Make sure `yt-dlp` is installed
Try, in order, until one prints a version:
```bash
python -m yt_dlp --version || python3 -m yt_dlp --version || py -m yt_dlp --version
```
If none works, install it (pick the interpreter that exists):
```bash
python -m pip install -q yt-dlp || python3 -m pip install -q yt-dlp || py -m pip install -q yt-dlp
```

### 2. Download the captions (no video)
Create a temp folder and pull subtitles. Prefer the **original language** (often
`*-orig`), then common languages. `<URL>` is the link the user sent.
```bash
mkdir -p /tmp/ytsub && cd /tmp/ytsub && rm -f *.vtt
python -m yt_dlp --skip-download --write-auto-sub --write-sub \
  --sub-langs "pt-orig,en-orig,pt,en,pt-PT,es" --sub-format vtt \
  --retries 10 --extractor-retries 5 --sleep-requests 2 \
  -o "vid.%(ext)s" "<URL>"
ls *.vtt
```
- On Windows, if `/tmp` is awkward, use a folder like `%TEMP%\ytsub` (or just the current dir).
- The log line `Downloading subtitles: en, pt-orig, ...` tells you which languages exist — pick the **original** one (the `*-orig`, or the language the speaker uses).
- **HTTP 429 / "Too Many Requests"**: wait a few seconds and retry; request fewer languages (just the original one) and keep `--retries`.
- If the log says there are **no subtitles**, tell the user the video has no captions, so you can't transcribe it.

### 3. Clean the VTT into readable text
Auto-captions repeat lines (rolling window) and carry timestamps. Write this
helper and run it on the `*.vtt` you chose (use the original-language file):
```bash
cat > /tmp/ytsub/clean.py <<'PY'
import re, sys, glob
src = sys.argv[1] if len(sys.argv) > 1 else sorted(glob.glob("/tmp/ytsub/*.vtt"))[0]
lines = open(src, encoding="utf-8").read().splitlines()
out, last, ts = [], "", None
for ln in lines:
    m = re.match(r"(\d\d:\d\d:\d\d)\.\d\d\d\s+-->", ln)
    if m: ts = m.group(1); continue
    if not ln.strip() or ln.startswith(("WEBVTT","Kind:","Language:")) or "align:" in ln or "-->" in ln: continue
    c = re.sub(r"<[^>]+>", "", ln).strip()
    if not c or c == last: continue
    last = c; out.append((ts, c))
text = []
for i,(t,c) in enumerate(out):
    if i % 25 == 0 and t: text.append("\n[%s] " % t)
    text.append(c)
open("/tmp/ytsub/clean.txt","w",encoding="utf-8").write(" ".join(text))
print("words:", len(" ".join(x[1] for x in out).split()))
PY
python /tmp/ytsub/clean.py /tmp/ytsub/vid.pt-orig.vtt 2>/dev/null || python /tmp/ytsub/clean.py
```
(Replace `vid.pt-orig.vtt` with whichever original-language file exists; if unsure, omit the argument and it uses the first `.vtt`.)

### 4. Read it and answer
Read `/tmp/ytsub/clean.txt` and do exactly what the user asked:
- Default: a clear summary of what the video covers.
- "Step by step" / "how to": extract the ordered steps the speaker describes.
- Cite **timestamps** (the `[hh:mm:ss]` markers) for key moments when helpful.
- Be honest about gaps: purely visual steps (shown on screen without narration)
  won't be in the captions — say so if it matters.

### 5. Clean up
Remove the temp files when done: `rm -f /tmp/ytsub/*`.

## Notes
- This works the same in the terminal (CLI) and over messaging channels (Telegram, etc.).
- Languages: always prefer the speaker's **original** language for accuracy, then translate/summarize in the language the user is writing to you.
