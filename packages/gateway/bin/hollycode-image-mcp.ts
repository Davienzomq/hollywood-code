#!/usr/bin/env bun
/**
 * Hollycode image-generation MCP server (stdio).
 *
 * Mirrors how Hermes does image generation: a FAL.ai backend with a small
 * multi-model catalog, but the agent only ever sees `prompt` + `aspect_ratio`
 * (landscape/square/portrait). The active model is picked from FAL_IMAGE_MODEL
 * (or the fast/cheap default) and the unified inputs are translated into each
 * model's native size spec, then filtered to its `supports` whitelist so FAL
 * never receives rejected keys.
 *
 * Backend auth: FAL_KEY in the environment. Get a free key at https://fal.ai.
 *
 * Protocol: this speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * by hand so it needs zero extra dependencies — opencode connects to it like
 * any other local MCP server (see packages/opencode/src/mcp/index.ts).
 */

// --- FAL model catalog (subset of Hermes', same shape) ----------------------
type SizeStyle = "image_size_preset" | "aspect_ratio" | "gpt_literal"
interface FalModel {
  display: string
  sizeStyle: SizeStyle
  sizes: { landscape: string; square: string; portrait: string }
  defaults: Record<string, unknown>
  supports: string[]
}

const FAL_MODELS: Record<string, FalModel> = {
  "fal-ai/flux-2/klein/9b": {
    display: "FLUX 2 Klein 9B",
    sizeStyle: "image_size_preset",
    sizes: { landscape: "landscape_16_9", square: "square_hd", portrait: "portrait_16_9" },
    defaults: { num_inference_steps: 4, output_format: "png", enable_safety_checker: false },
    supports: ["prompt", "image_size", "num_inference_steps", "seed", "output_format", "enable_safety_checker"],
  },
  "fal-ai/flux-2-pro": {
    display: "FLUX 2 Pro",
    sizeStyle: "image_size_preset",
    sizes: { landscape: "landscape_16_9", square: "square_hd", portrait: "portrait_16_9" },
    defaults: { num_inference_steps: 50, guidance_scale: 4.5, num_images: 1, output_format: "png", enable_safety_checker: false },
    supports: ["prompt", "image_size", "num_inference_steps", "guidance_scale", "num_images", "output_format", "enable_safety_checker", "seed"],
  },
  "fal-ai/nano-banana-pro": {
    display: "Nano Banana Pro (Gemini 3 Pro Image)",
    sizeStyle: "aspect_ratio",
    sizes: { landscape: "16:9", square: "1:1", portrait: "9:16" },
    defaults: { num_images: 1, output_format: "png", resolution: "1K" },
    supports: ["prompt", "aspect_ratio", "num_images", "output_format", "seed", "resolution"],
  },
  "fal-ai/gpt-image-1.5": {
    display: "GPT Image 1.5",
    sizeStyle: "gpt_literal",
    sizes: { landscape: "1536x1024", square: "1024x1024", portrait: "1024x1536" },
    defaults: { quality: "medium", num_images: 1, output_format: "png" },
    supports: ["prompt", "image_size", "quality", "num_images", "output_format"],
  },
}

const DEFAULT_MODEL = "fal-ai/flux-2/klein/9b"
const VALID_ASPECTS = ["landscape", "square", "portrait"] as const

function resolveModel(): [string, FalModel] {
  const want = (process.env.FAL_IMAGE_MODEL || "").trim()
  if (want && FAL_MODELS[want]) return [want, FAL_MODELS[want]!]
  return [DEFAULT_MODEL, FAL_MODELS[DEFAULT_MODEL]!]
}

function buildPayload(model: FalModel, prompt: string, aspect: string): Record<string, unknown> {
  const a = (VALID_ASPECTS as readonly string[]).includes(aspect) ? aspect : "landscape"
  const payload: Record<string, unknown> = { ...model.defaults, prompt: prompt.trim() }
  const size = model.sizes[a as keyof FalModel["sizes"]]
  if (model.sizeStyle === "aspect_ratio") payload.aspect_ratio = size
  else payload.image_size = size
  // filter to supports whitelist
  return Object.fromEntries(Object.entries(payload).filter(([k]) => model.supports.includes(k)))
}

async function generate(prompt: string, aspect: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const key = (process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim()
  if (!key) {
    return {
      ok: false,
      error: "FAL_KEY is not set. Get a free key at https://fal.ai and set FAL_KEY=<your-key>, then restart the server.",
    }
  }
  if (!prompt || !prompt.trim()) return { ok: false, error: "prompt is required" }
  const [modelId, model] = resolveModel()
  const args = buildPayload(model, prompt, aspect)
  try {
    // fal.run is the synchronous endpoint — it blocks until the image is ready.
    const res = await fetch(`https://fal.run/${modelId}`, {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { ok: false, error: `FAL ${res.status}: ${text.slice(0, 300)}` }
    }
    const data = (await res.json()) as { images?: Array<{ url?: string }> }
    const url = data.images?.[0]?.url
    if (!url) return { ok: false, error: "FAL returned no images" }
    return { ok: true, url }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// --- MCP stdio JSON-RPC plumbing --------------------------------------------
const PROTOCOL_VERSION = "2024-11-05"
const TOOL = {
  name: "generate_image",
  description:
    "Generate a high-quality image from a text prompt (FAL.ai backend). Returns an image URL — display it to the user with markdown ![description](url). Be detailed and descriptive in the prompt.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Detailed description of the desired image." },
      aspect_ratio: {
        type: "string",
        enum: VALID_ASPECTS,
        description: "landscape (16:9 wide), square (1:1), or portrait (16:9 tall).",
        default: "landscape",
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
        serverInfo: { name: "hollycode-image", version: "0.1.0" },
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
      if (params?.name !== "generate_image") {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${params?.name}` } })
        return
      }
      const prompt = String(params?.arguments?.prompt ?? "")
      const aspect = String(params?.arguments?.aspect_ratio ?? "landscape")
      const out = await generate(prompt, aspect)
      if (out.ok) {
        reply(id, { content: [{ type: "text", text: `Image generated:\n${out.url}\n\nDisplay it with: ![image](${out.url})` }] })
      } else {
        reply(id, { content: [{ type: "text", text: `Image generation failed: ${out.error}` }], isError: true })
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
