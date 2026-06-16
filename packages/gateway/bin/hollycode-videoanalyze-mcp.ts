#!/usr/bin/env bun
/**
 * Hollycode video-analysis MCP server (stdio).
 *
 * "Video analysis" here means: sample a few frames from a local video file
 * with ffmpeg, then send those frames to an OpenAI-compatible Chat
 * Completions vision endpoint (same calling style as hollycode-vision-mcp.ts)
 * along with the question. Raw video can't be sent to a chat/completions
 * endpoint — frames are the trick.
 *
 * ffmpeg resolution order: HOLLYCODE_FFMPEG env var, then the binary the
 * Hollycode installer bundles for voice transcription at
 * ~/.hollycode/ffmpeg/ffmpeg(.exe), then "ffmpeg" on PATH.
 *
 * Backend auth: VISION_API_KEY (or OPENAI_API_KEY) in the environment.
 * Backend base URL: VISION_API_URL, default https://api.openai.com/v1.
 * Backend model: VIDEO_ANALYZE_MODEL (or VISION_MODEL), default gpt-4o-mini.
 *
 * Protocol: this speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * by hand so it needs zero extra dependencies — opencode connects to it like
 * any other local MCP server (see packages/opencode/src/mcp/index.ts).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"

// --- ffmpeg resolution ---------------------------------------------------
function resolveFfmpeg(): string {
  const fromEnv = (process.env.HOLLYCODE_FFMPEG || "").trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const bundled = path.join(os.homedir(), ".hollycode", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
  if (existsSync(bundled)) return bundled
  return "ffmpeg"
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let p: ReturnType<typeof spawn>
    try {
      p = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"] })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    p.on("error", reject)
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}`))))
  })
}

// --- frame extraction ------------------------------------------------------
const MIN_FRAMES = 1
const MAX_FRAMES = 8
const DEFAULT_FRAMES = 4

function clampFrameCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FRAMES
  return Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, Math.round(n)))
}

/**
 * Extract up to `count` evenly-ish spaced frames from `video` into a fresh
 * temp dir using a low frame rate (fps=1) thumbnail sample, then keep only
 * the first `count` PNGs. This avoids needing to probe the video duration
 * up front. Falls back gracefully: if ffmpeg only manages to produce one
 * frame, that single frame is still acceptable.
 */
async function extractFrames(ffmpegBin: string, video: string, count: number): Promise<{ ok: true; dir: string; files: string[] } | { ok: false; error: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "holly-videoanalyze-"))
  const pattern = path.join(dir, "frame_%03d.png")
  try {
    // Sample at 1 frame/sec (capped to `count` frames) and scale down for a
    // smaller, faster vision payload. -frames:v caps total output frames so
    // long videos don't produce hundreds of files.
    await run(ffmpegBin, ["-y", "-i", video, "-vf", "fps=1,scale=512:-1", "-frames:v", String(count), pattern])
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let files: string[] = []
  try {
    files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".png"))
      .sort()
      .slice(0, count)
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (files.length === 0) {
    rmSync(dir, { recursive: true, force: true })
    return { ok: false, error: "ffmpeg produced no frames from this video" }
  }
  return { ok: true, dir, files }
}

// --- vision backend ----------------------------------------------------------
const DEFAULT_PROMPT = "Describe what happens in this video."
const DEFAULT_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_MODEL = "gpt-4o-mini"

function frameToDataUrl(filePath: string): string {
  const bytes = readFileSync(filePath)
  const b64 = Buffer.from(bytes).toString("base64")
  return `data:image/png;base64,${b64}`
}

async function analyzeVideo(video: string, prompt: string, frames: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!video || !video.trim()) return { ok: false, error: "video is required" }
  const videoPath = video.trim()
  if (!existsSync(videoPath)) return { ok: false, error: `"${videoPath}" is not a local file that exists.` }

  const key = (process.env.VISION_API_KEY || process.env.OPENAI_API_KEY || "").trim()
  if (!key) {
    return { ok: false, error: "No vision API key set. Set VISION_API_KEY or OPENAI_API_KEY." }
  }

  const ffmpegBin = resolveFfmpeg()
  if (ffmpegBin !== "ffmpeg" && !existsSync(ffmpegBin)) {
    return { ok: false, error: "ffmpeg not found. Run the Hollycode installer (it bundles ffmpeg) or install ffmpeg." }
  }

  const count = clampFrameCount(frames)
  const extracted = await extractFrames(ffmpegBin, videoPath, count)
  if (!extracted.ok) {
    const msg = extracted.error.toLowerCase()
    if (msg.includes("enoent") || msg.includes("not found")) {
      return { ok: false, error: "ffmpeg not found. Run the Hollycode installer (it bundles ffmpeg) or install ffmpeg." }
    }
    return { ok: false, error: `Frame extraction failed: ${extracted.error}` }
  }

  const baseUrl = (process.env.VISION_API_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "")
  const model = (process.env.VIDEO_ANALYZE_MODEL || process.env.VISION_MODEL || DEFAULT_MODEL).trim()
  const usePrompt = prompt && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT

  try {
    const imageParts = extracted.files.map((f) => ({
      type: "image_url" as const,
      image_url: { url: frameToDataUrl(path.join(extracted.dir, f)) },
    }))

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: usePrompt }, ...imageParts],
          },
        ],
        max_tokens: 1000,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { ok: false, error: `Vision API ${res.status}: ${text.slice(0, 300)}` }
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (!content) return { ok: false, error: "Vision API returned no content" }
    return { ok: true, text: content }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    rmSync(extracted.dir, { recursive: true, force: true })
  }
}

// --- MCP stdio JSON-RPC plumbing --------------------------------------------
const PROTOCOL_VERSION = "2024-11-05"
const TOOL = {
  name: "analyze_video",
  description:
    "Analyze a local video file by sampling a few frames with ffmpeg and sending them to a vision-capable LLM, then answer a question about what happens in the video.",
  inputSchema: {
    type: "object",
    properties: {
      video: { type: "string", description: "Absolute path to a local video file (mp4/mov/webm/etc)." },
      prompt: { type: "string", description: "The question to ask about the video.", default: DEFAULT_PROMPT },
      frames: { type: "number", description: "How many frames to sample (1-8).", default: DEFAULT_FRAMES },
    },
    required: ["video"],
  },
}

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function reply(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

async function handle(msg: any) {
  const { id, method, params } = msg
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "hollycode-videoanalyze", version: "0.1.0" },
      })
      return
    case "notifications/initialized":
    case "initialized":
      return // notification, no response
    case "ping":
      reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: [TOOL] })
      return
    case "tools/call": {
      if (params?.name !== "analyze_video") {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${params?.name}` } })
        return
      }
      const video = String(params?.arguments?.video ?? "")
      const prompt = String(params?.arguments?.prompt ?? DEFAULT_PROMPT)
      const framesArg = params?.arguments?.frames
      const frames = framesArg === undefined || framesArg === null ? DEFAULT_FRAMES : Number(framesArg)
      const out = await analyzeVideo(video, prompt, frames)
      if (out.ok) {
        reply(id, { content: [{ type: "text", text: out.text }] })
      } else {
        reply(id, { content: [{ type: "text", text: `Video analysis failed: ${out.error}` }], isError: true })
      }
      return
    }
    default:
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let nl: number
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg).catch((e) => {
      if (msg?.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } })
    })
  }
})
process.stdin.on("end", () => process.exit(0))
