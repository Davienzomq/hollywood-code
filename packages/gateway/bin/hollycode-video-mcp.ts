#!/usr/bin/env bun
/**
 * Hollycode video-generation MCP server (stdio).
 *
 * Mirrors hollycode-image-mcp.ts: a FAL.ai backend with a small multi-model
 * catalog, but the agent only ever sees `prompt` + `aspect_ratio`
 * (landscape/square/portrait) + an optional `duration`. The active model is
 * picked from FAL_VIDEO_MODEL (or the default), and the unified inputs are
 * translated into each model's native fields, then filtered to its
 * `supports` whitelist so FAL never receives rejected keys.
 *
 * Backend auth: FAL_KEY in the environment. Get a free key at https://fal.ai.
 *
 * Protocol: this speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * by hand so it needs zero extra dependencies — opencode connects to it like
 * any other local MCP server (see packages/opencode/src/mcp/index.ts).
 */

// --- FAL model catalog -------------------------------------------------------
interface FalVideoModel {
  display: string
  aspectRatios: { landscape: string; square: string; portrait: string }
  defaults: Record<string, unknown>
  supports: string[]
}

const FAL_MODELS: Record<string, FalVideoModel> = {
  "fal-ai/kling-video/v1/standard/text-to-video": {
    display: "Kling Video v1 Standard (text-to-video)",
    aspectRatios: { landscape: "16:9", square: "1:1", portrait: "9:16" },
    defaults: { duration: "5" },
    supports: ["prompt", "aspect_ratio", "duration"],
  },
  "fal-ai/minimax/video-01": {
    display: "Minimax Video-01",
    aspectRatios: { landscape: "16:9", square: "1:1", portrait: "9:16" },
    defaults: {},
    supports: ["prompt"],
  },
  "fal-ai/luma-dream-machine": {
    display: "Luma Dream Machine",
    aspectRatios: { landscape: "16:9", square: "1:1", portrait: "9:16" },
    defaults: {},
    supports: ["prompt", "aspect_ratio"],
  },
}

const DEFAULT_MODEL = "fal-ai/kling-video/v1/standard/text-to-video"
const VALID_ASPECTS = ["landscape", "square", "portrait"] as const

function resolveModel(): [string, FalVideoModel] {
  const want = (process.env.FAL_VIDEO_MODEL || "").trim()
  if (want && FAL_MODELS[want]) return [want, FAL_MODELS[want]!]
  return [DEFAULT_MODEL, FAL_MODELS[DEFAULT_MODEL]!]
}

function buildPayload(model: FalVideoModel, prompt: string, aspect: string, duration?: string): Record<string, unknown> {
  const a = (VALID_ASPECTS as readonly string[]).includes(aspect) ? aspect : "landscape"
  const payload: Record<string, unknown> = { ...model.defaults, prompt: prompt.trim() }
  payload.aspect_ratio = model.aspectRatios[a as keyof FalVideoModel["aspectRatios"]]
  if (duration && duration.trim()) payload.duration = duration.trim()
  // filter to supports whitelist
  return Object.fromEntries(Object.entries(payload).filter(([k]) => model.supports.includes(k)))
}

async function generate(
  prompt: string,
  aspect: string,
  duration?: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const key = (process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim()
  if (!key) {
    return {
      ok: false,
      error: "FAL_KEY is not set. Get a free key at https://fal.ai and set FAL_KEY=<your-key>, then restart the server.",
    }
  }
  if (!prompt || !prompt.trim()) return { ok: false, error: "prompt is required" }
  const [modelId, model] = resolveModel()
  const args = buildPayload(model, prompt, aspect, duration)
  try {
    // fal.run is the synchronous endpoint — it blocks until the video is ready.
    // Video generation is slow; this can take a while, which is expected.
    const res = await fetch(`https://fal.run/${modelId}`, {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { ok: false, error: `FAL ${res.status}: ${text.slice(0, 300)}` }
    }
    const data = (await res.json()) as { video?: { url?: string } }
    const url = data.video?.url
    if (!url) return { ok: false, error: "FAL returned no video" }
    return { ok: true, url }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// --- MCP stdio JSON-RPC plumbing --------------------------------------------
const PROTOCOL_VERSION = "2024-11-05"
const TOOL = {
  name: "generate_video",
  description:
    "Generate a short video from a text prompt (FAL.ai backend). Returns a video URL — display/share it to the user. Be detailed and descriptive in the prompt.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Detailed description of the desired video." },
      aspect_ratio: {
        type: "string",
        enum: VALID_ASPECTS,
        description: "landscape (16:9 wide), square (1:1), or portrait (9:16 tall).",
        default: "landscape",
      },
      duration: {
        type: "string",
        description: "Desired video duration in seconds (e.g. \"5\"), if the model supports it.",
      },
    },
    required: ["prompt"],
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
        serverInfo: { name: "hollycode-video", version: "0.1.0" },
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
      if (params?.name !== "generate_video") {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${params?.name}` } })
        return
      }
      const prompt = String(params?.arguments?.prompt ?? "")
      const aspect = String(params?.arguments?.aspect_ratio ?? "landscape")
      const durationArg = params?.arguments?.duration
      const duration = durationArg === undefined || durationArg === null ? undefined : String(durationArg)
      const out = await generate(prompt, aspect, duration)
      if (out.ok) {
        reply(id, { content: [{ type: "text", text: `Video generated:\n${out.url}\n\nDisplay/share it: ${out.url}` }] })
      } else {
        reply(id, { content: [{ type: "text", text: `Video generation failed: ${out.error}` }], isError: true })
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
