#!/usr/bin/env bun
/**
 * Hollycode computer-use (desktop control) MCP server (stdio).
 *
 * Cross-platform desktop automation (Windows/macOS/Linux) by shelling out to
 * Python + pyautogui. This TS process only speaks the MCP protocol; every
 * actual OS action (mouse, keyboard, screenshot) runs as a small Python
 * snippet in a child process.
 *
 * Backend: a `python` / `python3` / `py` interpreter on PATH. pyautogui (and
 * pillow, needed for screenshots) are auto-installed on first use if missing.
 *
 * Protocol: this speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * by hand so it needs zero extra dependencies — opencode connects to it like
 * any other local MCP server (see packages/opencode/src/mcp/index.ts).
 */

import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

// --- Python interpreter resolution ------------------------------------------
const PY_CANDIDATES = ["python", "python3", "py"]
let resolvedPy: string | null = null
let pyautoguiReady = false

function tryRun(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8" })
    if (res.error) return { ok: false, stdout: "", stderr: String(res.error.message || res.error) }
    return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
  } catch (e) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) }
  }
}

function resolveInterpreter(): string | null {
  if (resolvedPy) return resolvedPy
  for (const candidate of PY_CANDIDATES) {
    const out = tryRun(candidate, ["--version"])
    if (out.ok) {
      resolvedPy = candidate
      return resolvedPy
    }
  }
  return null
}

function ensurePyautogui(py: string): { ok: boolean; error?: string } {
  if (pyautoguiReady) return { ok: true }
  const check = tryRun(py, ["-c", "import pyautogui"])
  if (check.ok) {
    pyautoguiReady = true
    return { ok: true }
  }
  const install = tryRun(py, ["-m", "pip", "install", "-q", "pyautogui", "pillow"])
  if (!install.ok) {
    return { ok: false, error: `Failed to install pyautogui/pillow: ${install.stderr || install.stdout}` }
  }
  const recheck = tryRun(py, ["-c", "import pyautogui"])
  if (!recheck.ok) {
    return { ok: false, error: `pyautogui still not importable after install: ${recheck.stderr || recheck.stdout}` }
  }
  pyautoguiReady = true
  return { ok: true }
}

/** Spawn Python running `code` (with pyautogui auto-imported) and return the result. */
function runPy(code: string): { ok: boolean; stdout: string; stderr: string } {
  const py = resolveInterpreter()
  if (!py) {
    return { ok: false, stdout: "", stderr: "No Python interpreter found (tried python, python3, py). Install Python and ensure it's on PATH." }
  }
  const ready = ensurePyautogui(py)
  if (!ready.ok) {
    return { ok: false, stdout: "", stderr: ready.error || "pyautogui unavailable" }
  }
  const full = `import pyautogui\npyautogui.FAILSAFE=False\n${code}`
  const res = spawnSync(py, ["-c", full], { encoding: "utf8" })
  if (res.error) return { ok: false, stdout: "", stderr: String(res.error.message || res.error) }
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

// --- arg parsing helpers -----------------------------------------------------
function asNumber(value: unknown, name: string): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a finite number, got: ${JSON.stringify(value)}`)
  return n
}

function asString(value: unknown, name: string, fallback?: string): string {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    throw new Error(`"${name}" is required`)
  }
  return String(value)
}

function pyStr(s: string): string {
  // Safe Python single-quoted string literal.
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r") + "'"
}

// --- tool implementations -----------------------------------------------------
type ToolResult = { ok: true; text: string } | { ok: false; error: string }

function screenshotTool(): ToolResult {
  const path = join(tmpdir(), `hollycode-screenshot-${randomUUID()}.png`)
  const code = `img = pyautogui.screenshot()\nimg.save(${pyStr(path)})\nprint(${pyStr(path)})`
  const res = runPy(code)
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "screenshot failed" }
  return { ok: true, text: `Screenshot saved: ${path}` }
}

function moveTool(args: Record<string, unknown>): ToolResult {
  const x = asNumber(args.x, "x")
  const y = asNumber(args.y, "y")
  const res = runPy(`pyautogui.moveTo(${x}, ${y})`)
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "move failed" }
  return { ok: true, text: `Moved to (${x}, ${y})` }
}

function clickTool(args: Record<string, unknown>): ToolResult {
  const x = asNumber(args.x, "x")
  const y = asNumber(args.y, "y")
  const button = asString(args.button, "button", "left")
  const res = runPy(`pyautogui.click(${x}, ${y}, button=${pyStr(button)})`)
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "click failed" }
  return { ok: true, text: `Clicked (${x}, ${y}) with ${button} button` }
}

function doubleClickTool(args: Record<string, unknown>): ToolResult {
  const x = asNumber(args.x, "x")
  const y = asNumber(args.y, "y")
  const res = runPy(`pyautogui.doubleClick(${x}, ${y})`)
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "double_click failed" }
  return { ok: true, text: `Double-clicked (${x}, ${y})` }
}

function typeTextTool(args: Record<string, unknown>): ToolResult {
  const text = asString(args.text, "text")
  const res = runPy(`pyautogui.typewrite(${pyStr(text)}, interval=0.01)`)
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "type_text failed" }
  return { ok: true, text: `Typed text (${text.length} chars)` }
}

function pressKeyTool(args: Record<string, unknown>): ToolResult {
  const raw = asString(args.keys, "keys")
  const keys = raw
    .split(/[,+]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
  if (keys.length === 0) return { ok: false, error: '"keys" must contain at least one key' }
  const code = keys.length > 1 ? `pyautogui.hotkey(${keys.map(pyStr).join(", ")})` : `pyautogui.press(${pyStr(keys[0]!)})`
  const res = runPy(code)
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "press_key failed" }
  return { ok: true, text: `Pressed: ${keys.join("+")}` }
}

function scrollTool(args: Record<string, unknown>): ToolResult {
  const amount = asNumber(args.amount, "amount")
  const res = runPy(`pyautogui.scroll(${amount})`)
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "scroll failed" }
  return { ok: true, text: `Scrolled by ${amount}` }
}

function screenSizeTool(): ToolResult {
  const res = runPy(`s = pyautogui.size()\nprint(f"{s.width}x{s.height}")`)
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "screen_size failed" }
  return { ok: true, text: res.stdout.trim() }
}

// --- MCP stdio JSON-RPC plumbing --------------------------------------------
const PROTOCOL_VERSION = "2024-11-05"

const TOOLS = [
  {
    name: "screenshot",
    description: "Take a screenshot of the current screen and save it to a temp PNG file. Returns the absolute file path.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "move",
    description: "Move the mouse cursor to absolute screen coordinates (x, y).",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
  },
  {
    name: "click",
    description: "Click the mouse at absolute screen coordinates (x, y). Button defaults to 'left'.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "double_click",
    description: "Double-click the mouse at absolute screen coordinates (x, y).",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
  },
  {
    name: "type_text",
    description: "Type the given text using the keyboard, one character at a time.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "press_key",
    description:
      "Press a key or key combo. Comma- or plus-separated for combos, e.g. \"ctrl,c\" or \"ctrl+c\" triggers a hotkey; a single key like \"enter\" is pressed alone.",
    inputSchema: {
      type: "object",
      properties: { keys: { type: "string", description: "e.g. 'enter' or 'ctrl,c'" } },
      required: ["keys"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the mouse wheel by the given amount (positive scrolls up, negative scrolls down).",
    inputSchema: {
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
    },
  },
  {
    name: "screen_size",
    description: "Get the primary screen resolution as \"WIDTHxHEIGHT\".",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
]

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name))

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function reply(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

function runTool(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case "screenshot":
      return screenshotTool()
    case "move":
      return moveTool(args)
    case "click":
      return clickTool(args)
    case "double_click":
      return doubleClickTool(args)
    case "type_text":
      return typeTextTool(args)
    case "press_key":
      return pressKeyTool(args)
    case "scroll":
      return scrollTool(args)
    case "screen_size":
      return screenSizeTool()
    default:
      return { ok: false, error: `Unknown tool: ${name}` }
  }
}

async function handle(msg: any) {
  const { id, method, params } = msg
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "hollycode-computeruse", version: "0.1.0" },
      })
      return
    case "notifications/initialized":
    case "initialized":
      return // notification, no response
    case "ping":
      reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: TOOLS })
      return
    case "tools/call": {
      const name = params?.name
      if (typeof name !== "string" || !TOOL_NAMES.has(name)) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } })
        return
      }
      const args = (params?.arguments ?? {}) as Record<string, unknown>
      try {
        const out = runTool(name, args)
        if (out.ok) {
          reply(id, { content: [{ type: "text", text: out.text }] })
        } else {
          reply(id, { content: [{ type: "text", text: out.error }], isError: true })
        }
      } catch (e) {
        reply(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true })
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
