// Phase B — voice. A tiny transcription provider behind an interface so any
// channel that receives audio (Telegram voice notes, WhatsApp/Discord audio)
// can turn it into text and feed the normal prompt flow. Uses an
// OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, or a local
// Whisper server all speak it) via multipart fetch — no SDK needed.

export interface Transcriber {
  transcribe(audio: Uint8Array, filename: string): Promise<string>
}

export interface VoiceConfig {
  /** API key for the transcription endpoint (and for the "api" TTS engine). */
  apiKey?: string
  /** Base URL; defaults to OpenAI. Use Groq (api.groq.com/openai/v1) for speed/cost. */
  apiUrl?: string
  /** Transcription model; defaults to "whisper-1" — use "whisper-large-v3" on Groq. */
  model?: string
  /** Spoken language hint (e.g. "pt", "en"). Forcing it beats auto-detect on
   *  short voice notes, where detection is the main source of garbage output. */
  language?: string
  /** STT engine: "whisper-local" = free local whisper.cpp (default when present); "api" = cloud. */
  sttEngine?: "whisper-local" | "api"
  /** Path to the whisper.cpp binary (default: bundled ~/.hollycode/whisper/main.exe). */
  whisperBin?: string
  /** Path to the whisper ggml model (default: bundled ~/.hollycode/whisper/model.bin). */
  whisperModel?: string
  /** Path to ffmpeg (default: bundled ~/.hollycode/ffmpeg/ffmpeg.exe) — converts Ogg→WAV. */
  ffmpegBin?: string
  /** TTS engine: "piper" = free local (default when no apiKey); "api" = cloud. */
  ttsEngine?: "piper" | "api"
  /** TTS model for the cloud engine; defaults to "tts-1". */
  ttsModel?: string
  /** TTS voice for the cloud engine; defaults to "alloy". */
  ttsVoice?: string
  /** Path to the piper binary (default: "piper" on PATH, or the bundled one). */
  piperBin?: string
  /** Path to the piper voice model (.onnx). Bundled by the installer. */
  piperModel?: string
}

/** Text → speech (voice replies). Output is Ogg/Opus (api) or WAV (piper). */
export interface Speaker {
  synthesize(text: string): Promise<Uint8Array>
}

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Make agent text SPEAKABLE. Replies are markdown ("**bold**", `code`, bullets,
// links, emojis) and the TTS used to read the symbols out loud — "sua stock
// asterisco asterisco está em asterisco por cento". Strip everything that isn't
// meant to be heard, keep the words. Applied inside BOTH speakers so every voice
// path (voice replies, /speak, the agent's `say` tool) is covered.
export function sanitizeForSpeech(text: string): string {
  let t = text
  // fenced code blocks are unreadable aloud — summarize their presence
  t = t.replace(/```[\s\S]*?```/g, " (trecho de código omitido) ")
  // inline code: keep the content, drop the backticks
  t = t.replace(/`([^`\n]*)`/g, "$1")
  // links: [label](url) → label ; bare URLs → "link"
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  t = t.replace(/https?:\/\/\S+/g, " link ")
  // markdown emphasis/headers/quotes/bullets/tables — keep words, drop markers
  t = t.replace(/[*_~#>|]+/g, " ")
  // list numbering "1." at line starts reads awkwardly → drop the dot
  t = t.replace(/^\s*\d+\.\s+/gm, " ")
  t = t.replace(/^\s*[-•]\s+/gm, " ")
  // emojis & pictographs (Piper mispronounces or chokes on them)
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/gu, " ")
  // symbols that read badly aloud
  t = t.replace(/[<>{}\[\]\\^=+]/g, " ")
  // punctuation runs ("...", "!!", "--") → a single mark; ellipses read as pause
  t = t.replace(/([!?.,;:])\1+/g, "$1")
  t = t.replace(/\s*-{2,}\s*/g, ", ")
  // collapse whitespace/newlines into natural sentence flow
  t = t.replace(/\n{2,}/g, ". ").replace(/\n/g, ", ").replace(/\s{2,}/g, " ")
  // tidy stray commas/periods produced by the stripping
  t = t.replace(/\s+([,.;:!?])/g, "$1").replace(/([,.])\s*\1+/g, "$1")
  return t.trim()
}

// Free, fully-local TTS via the Piper binary (Open Home Foundation). Reads text
// on stdin, writes a WAV — no API key, works offline. The installer bundles the
// binary + default voice model under ~/.hollycode/piper.
function createPiperSpeaker(cfg: VoiceConfig): Speaker {
  const home = os.homedir()
  const defaultModel = path.join(home, ".hollycode", "piper", "voice.onnx")
  const bin = cfg.piperBin || path.join(home, ".hollycode", "piper", process.platform === "win32" ? "piper.exe" : "piper")
  const model = cfg.piperModel || defaultModel
  return {
    synthesize(rawText: string): Promise<Uint8Array> {
      const text = sanitizeForSpeech(rawText)
      return new Promise((resolve, reject) => {
        const out = path.join(os.tmpdir(), `holly-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
        const piperExe = fs.existsSync(bin) ? bin : "piper" // fall back to PATH
        const proc = spawn(piperExe, ["--model", model, "--output_file", out], { stdio: ["pipe", "ignore", "ignore"] })
        proc.on("error", (err) => reject(err))
        proc.on("exit", () => {
          try {
            const buf = fs.readFileSync(out)
            fs.unlinkSync(out)
            resolve(new Uint8Array(buf))
          } catch (err) {
            reject(err)
          }
        })
        // stdin errors (EPIPE when the binary is missing/dies early) are emitted
        // on the STREAM — unhandled they'd crash the whole gateway process.
        proc.stdin.on("error", () => {})
        try {
          proc.stdin.write(text.slice(0, 4000))
          proc.stdin.end()
        } catch (err) {
          reject(err)
        }
      })
    },
  }
}

function createApiSpeaker(cfg: VoiceConfig): Speaker {
  const base = (cfg.apiUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")
  const model = cfg.ttsModel ?? "tts-1"
  const voice = cfg.ttsVoice ?? "alloy"
  return {
    async synthesize(rawText: string): Promise<Uint8Array> {
      const text = sanitizeForSpeech(rawText)
      const res = await fetch(`${base}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, voice, input: text.slice(0, 4000), response_format: "opus" }),
      })
      if (!res.ok) throw new Error(`tts failed: ${res.status} ${await res.text().catch(() => "")}`)
      return new Uint8Array(await res.arrayBuffer())
    },
  }
}

export function createSpeaker(cfg: VoiceConfig): Speaker {
  const engine = cfg.ttsEngine ?? (cfg.apiKey ? "api" : "piper")
  return engine === "piper" ? createPiperSpeaker(cfg) : createApiSpeaker(cfg)
}

function createApiTranscriber(cfg: VoiceConfig): Transcriber {
  const base = (cfg.apiUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")
  const model = cfg.model ?? "whisper-1"
  return {
    async transcribe(audio: Uint8Array, filename: string): Promise<string> {
      const form = new FormData()
      form.append("file", new Blob([audio as unknown as BlobPart]), filename)
      form.append("model", model)
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiKey}` },
        body: form,
      })
      if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text().catch(() => "")}`)
      const data = (await res.json()) as { text?: string }
      return (data.text ?? "").trim()
    },
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"] })
    p.on("error", reject)
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}`))))
  })
}

// Free, fully-local STT: ffmpeg converts the voice note to 16 kHz mono WAV, then
// whisper.cpp transcribes it. No API key, works offline. Binaries + model are
// bundled by the installer under ~/.hollycode/{whisper,ffmpeg}.
// Binary names differ by OS — only Windows uses the .exe suffix. Hardcoding
// .exe broke local STT on macOS/Linux (the bins are "main" and "ffmpeg").
const EXE = process.platform === "win32" ? ".exe" : ""

// whisper.cpp ≥1.7.4 renamed the CLI main → whisper-cli (main.exe became a
// deprecation shim that does nothing). Prefer the new name, fall back to the old.
function defaultWhisperBin(): string {
  const dir = path.join(os.homedir(), ".hollycode", "whisper")
  const cli = path.join(dir, `whisper-cli${EXE}`)
  return fs.existsSync(cli) ? cli : path.join(dir, `main${EXE}`)
}

function createLocalTranscriber(cfg: VoiceConfig): Transcriber {
  const home = os.homedir()
  const whisperBin = cfg.whisperBin || defaultWhisperBin()
  const whisperModel = cfg.whisperModel || path.join(home, ".hollycode", "whisper", "model.bin")
  const ffmpegBin = cfg.ffmpegBin || path.join(home, ".hollycode", "ffmpeg", `ffmpeg${EXE}`)
  return {
    async transcribe(audio: Uint8Array, _filename: string): Promise<string> {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const ogg = path.join(os.tmpdir(), `holly-stt-${stamp}.ogg`)
      const wav = path.join(os.tmpdir(), `holly-stt-${stamp}.wav`)
      const prefix = path.join(os.tmpdir(), `holly-stt-${stamp}-out`)
      const txt = `${prefix}.txt`
      try {
        fs.writeFileSync(ogg, audio)
        await run(ffmpegBin, ["-i", ogg, "-ar", "16000", "-ac", "1", "-y", wav])
        // -t <threads>: whisper.cpp defaults to 4 threads; using the machine's
        // real cores (capped) meaningfully speeds up transcription of each note.
        // -bs 5: beam search — clearly better accuracy, and with the model-load
        // time dominating each run it's essentially free.
        // -l: forcing the configured language beats auto-detect on short notes.
        const threads = String(Math.min(8, Math.max(1, os.cpus().length)))
        const lang = cfg.language || "auto"
        await run(whisperBin, ["-m", whisperModel, "-f", wav, "-l", lang, "-otxt", "-nt", "-bs", "5", "-t", threads, "-of", prefix])
        const text = fs.readFileSync(txt, "utf8").trim()
        return text
      } finally {
        for (const f of [ogg, wav, txt]) fs.existsSync(f) && fs.unlinkSync(f)
      }
    },
  }
}

/** Local whisper.cpp is available if its binary + model + ffmpeg are present. */
export function localSttAvailable(cfg?: VoiceConfig): boolean {
  const home = os.homedir()
  const wb = cfg?.whisperBin || defaultWhisperBin()
  const wm = cfg?.whisperModel || path.join(home, ".hollycode", "whisper", "model.bin")
  const fb = cfg?.ffmpegBin || path.join(home, ".hollycode", "ffmpeg", `ffmpeg${EXE}`)
  return fs.existsSync(wb) && fs.existsSync(wm) && fs.existsSync(fb)
}

export function createTranscriber(cfg: VoiceConfig): Transcriber {
  const engine = cfg.sttEngine ?? (localSttAvailable(cfg) ? "whisper-local" : "api")
  return engine === "whisper-local" ? createLocalTranscriber(cfg) : createApiTranscriber(cfg)
}
