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

// Free, fully-local TTS via the Piper binary (Open Home Foundation). Reads text
// on stdin, writes a WAV — no API key, works offline. The installer bundles the
// binary + default voice model under ~/.hollycode/piper.
function createPiperSpeaker(cfg: VoiceConfig): Speaker {
  const home = os.homedir()
  const defaultModel = path.join(home, ".hollycode", "piper", "voice.onnx")
  const bin = cfg.piperBin || path.join(home, ".hollycode", "piper", process.platform === "win32" ? "piper.exe" : "piper")
  const model = cfg.piperModel || defaultModel
  return {
    synthesize(text: string): Promise<Uint8Array> {
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
        proc.stdin.write(text.slice(0, 4000))
        proc.stdin.end()
      })
    },
  }
}

function createApiSpeaker(cfg: VoiceConfig): Speaker {
  const base = (cfg.apiUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")
  const model = cfg.ttsModel ?? "tts-1"
  const voice = cfg.ttsVoice ?? "alloy"
  return {
    async synthesize(text: string): Promise<Uint8Array> {
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
function createLocalTranscriber(cfg: VoiceConfig): Transcriber {
  const home = os.homedir()
  const whisperBin = cfg.whisperBin || path.join(home, ".hollycode", "whisper", "main.exe")
  const whisperModel = cfg.whisperModel || path.join(home, ".hollycode", "whisper", "model.bin")
  const ffmpegBin = cfg.ffmpegBin || path.join(home, ".hollycode", "ffmpeg", "ffmpeg.exe")
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
        await run(whisperBin, ["-m", whisperModel, "-f", wav, "-l", "auto", "-otxt", "-nt", "-of", prefix])
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
  const wb = cfg?.whisperBin || path.join(home, ".hollycode", "whisper", "main.exe")
  const wm = cfg?.whisperModel || path.join(home, ".hollycode", "whisper", "model.bin")
  const fb = cfg?.ffmpegBin || path.join(home, ".hollycode", "ffmpeg", "ffmpeg.exe")
  return fs.existsSync(wb) && fs.existsSync(wm) && fs.existsSync(fb)
}

export function createTranscriber(cfg: VoiceConfig): Transcriber {
  const engine = cfg.sttEngine ?? (localSttAvailable(cfg) ? "whisper-local" : "api")
  return engine === "whisper-local" ? createLocalTranscriber(cfg) : createApiTranscriber(cfg)
}
