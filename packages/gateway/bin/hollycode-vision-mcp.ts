#!/usr/bin/env bun
/**
 * Hollycode vision-analysis MCP server (stdio).
 *
 * A single `analyze_image` tool backed by an OpenAI-compatible Chat
 * Completions vision endpoint (NOT FAL). Accepts either an http(s) image URL
 * or an absolute local file path — local files are read, base64-encoded, and
 * sent as a data URL since most vision endpoints can't reach the local disk.
 *
 * Backend auth: VISION_API_KEY (or OPENAI_API_KEY) in the environment.
 * Backend base URL: VISION_API_URL, default https://api.openai.com/v1.
 * Backend model: VISION_MODEL, default gpt-4o-mini.
 *
 * Protocol: this speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * by hand so it needs zero extra dependencies — opencode connects to it like
 * any other local MCP server (see packages/opencode/src/mcp/index.ts).
 */

import { existsSync, readFileSync } from "node:fs"

// --- vision backend ----------------------------------------------------------
const DEFAULT_PROMPT = "Describe this image in detail."
const DEFAULT_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_MODEL = "gpt-4o-mini"

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".")
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : ""
  return MIME_BY_EXT[ext] || "image/png"
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function resolveImageUrl(image: string): { ok: true; url: string } | { ok: false; error: string } {
  if (isHttpUrl(image)) return { ok: true, url: image }
  if (existsSync(image)) {
    try {
      const bytes = readFileSync(image)
      const b64 = Buffer.from(bytes).toString("base64")
      const mime = mimeForPath(image)
      return { ok: true, url: `data:${mime};base64,${b64}` }
    } catch (e) {
      return { ok: false, error: `Failed to read local file "${image}": ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return { ok: false, error: `"${image}" is not an http(s) URL and not a local file that exists.` }
}

async function analyze(image: string, prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const key = (process.env.VISION_API_KEY || process.env.OPENAI_API_KEY || "").trim()
  if (!key) {
    return {
      ok: false,
      error: "No vision API key set. Set VISION_API_KEY (or OPENAI_API_KEY) and restart.",
    }
  }
  if (!image || !image.trim()) return { ok: false, error: "image is required" }
  const baseUrl = (process.env.VISION_API_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "")
  const model = (process.env.VISION_MODEL || DEFAULT_MODEL).trim()
  const usePrompt = prompt && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT

  const resolved = resolveImageUrl(image.trim())
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: usePrompt },
              { type: "image_url", image_url: { url: resolved.url } },
            ],
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
  }
}

// --- MCP stdio JSON-RPC plumbing --------------------------------------------
const PROTOCOL_VERSION = "2024-11-05"
const TOOL = {
  name: "analyze_image",
  description: "Analyze an image (http(s) URL or absolute local file path) with a vision-capable LLM and answer a question about it.",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "string", description: "An http(s) URL or an absolute local file path of the image to analyze." },
      prompt: { type: "string", description: "The question to ask about the image.", default: DEFAULT_PROMPT },
    },
    required: ["image"],
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
        serverInfo: { name: "hollycode-vision", version: "0.1.0" },
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
      if (params?.name !== "analyze_image") {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${params?.name}` } })
        return
      }
      const image = String(params?.arguments?.image ?? "")
      const prompt = String(params?.arguments?.prompt ?? DEFAULT_PROMPT)
      const out = await analyze(image, prompt)
      if (out.ok) {
        reply(id, { content: [{ type: "text", text: out.text }] })
      } else {
        reply(id, { content: [{ type: "text", text: `Vision analysis failed: ${out.error}` }], isError: true })
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
