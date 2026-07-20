// Hollycode Gateway — channel-agnostic engine.
// All agent logic from packages/telegram/src/index.ts, with zero platform code.
// Wherever index.ts called ctx.reply / bot.api, we call methods on the Responder.

import { createOpencodeClient, type ToolPart } from "@opencode-ai/sdk"
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { GatewayContext, Responder, StatusHandle } from "./types"
import { type GatewayConfig, saveGatewayConfig, channel } from "./config"
import type { SchedulerHandle } from "./scheduler"
import { createTranscriber, createSpeaker, localSttAvailable } from "./transcription"
import { installStartup, removeStartup, startupStatus } from "./startup"
import { openRecallIndex } from "./search"
import { openMemoryStore, sectionBullets, removeSection, writeSection } from "./memory"
import { installAgentTools, processAgentInbox } from "./agent-cron"

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = (scope: string, message: string) => console.log(`[${scope}] ${message}`)

// ---------------------------------------------------------------------------
// Server boot
// ---------------------------------------------------------------------------

let serverProc: ChildProcess | undefined

function bootServer(directory: string): Promise<{ url: string; close: () => void }> {
  const serverIndex = path.resolve(HERE, "../../opencode/src/index.ts")
  const env: Record<string, string | undefined> = { ...process.env }
  const proc = spawn(
    process.execPath,
    ["run", serverIndex, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    { cwd: directory, env, stdio: ["ignore", "pipe", "inherit"] },
  )
  serverProc = proc
  return new Promise((resolve, reject) => {
    let buf = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(new Error("Hollywood Code server did not start in time"))
    }, 30_000)
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return
      buf += chunk.toString()
      const match = buf.match(/server listening on\s+(https?:\/\/[^\s]+)/)
      if (match) {
        settled = true
        clearTimeout(timer)
        resolve({
          url: match[1]!,
          close: () => {
            proc.kill()
            serverProc = undefined
          },
        })
      }
    })
    proc.on("exit", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Server exited early with code ${code}`))
    })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readJsonc = (p: string) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")) as any

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export async function createEngine(config: GatewayConfig): Promise<{
  context: GatewayContext
  stop: () => void
  runPrompt: (channelId: string, conversationId: string, text: string) => Promise<string>
  setScheduler: (s: SchedulerHandle) => void
  setDeliver: (d: (channelId: string, conversationId: string, text: string) => Promise<void>) => void
  setDeliverVoice: (d: (channelId: string, conversationId: string, audio: Uint8Array) => Promise<void>) => void
  setDeliverImage: (
    d: (channelId: string, conversationId: string, data: Uint8Array, filename: string, caption?: string) => Promise<void>,
  ) => void
}> {
  let DIRECTORY = config.directory || process.cwd()

  // Be resilient if the configured project directory was deleted/moved: create
  // it so applyPermissionMode and the server spawn (cwd) don't crash on ENOENT.
  try {
    fs.mkdirSync(DIRECTORY, { recursive: true })
  } catch {
    // fall back to cwd if we somehow can't create it
    DIRECTORY = process.cwd()
    config.directory = DIRECTORY
  }

  // Phase C: injected by the gateway after adapters exist, so /schedule works.
  let scheduler: SchedulerHandle | undefined
  // Injected by the gateway: deliver text to a chat (used by the send_message tool).
  let deliver: ((channelId: string, conversationId: string, text: string) => Promise<void>) | undefined
  // Injected by the gateway: deliver voice/audio to a chat (used by the say/TTS tool).
  let deliverVoice: ((channelId: string, conversationId: string, audio: Uint8Array) => Promise<void>) | undefined
  // Injected by the gateway: deliver an inline image (used by the send_image tool).
  let deliverImage:
    | ((channelId: string, conversationId: string, data: Uint8Array, filename: string, caption?: string) => Promise<void>)
    | undefined

  // /debug — verbose logging toggle.
  let verbose = config.debug ?? false

  // /goal — per-conversation goal strings, keyed by sessionKey.
  const goalMap = new Map<string, string>()

  // /loop — per-conversation setInterval handles, keyed by sessionKey.
  const loopMap = new Map<string, ReturnType<typeof setInterval>>()

  // --- Session persistence (keyed by "channelId:conversationId") -----------
  const STORE = path.join(os.homedir(), ".hollywood-gateway-sessions.json")
  const sessionMap = new Map<string, string>() // "channelId:conversationId" → sessionID
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8")) as Record<string, string>
    for (const [k, v] of Object.entries(raw)) sessionMap.set(k, v)
  } catch {
    // first run
  }
  const saveStore = () => {
    try {
      const tmp = STORE + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessionMap), null, 2))
      fs.renameSync(tmp, STORE)
    } catch (err) {
      console.error("Could not persist session store:", err)
    }
  }

  // --- Per-project session memory ------------------------------------------
  // Remembers the last session used in each project directory (per conversation)
  // so /move back to a project resumes where you left off — no /sessions needed.
  const PROJ_STORE = path.join(os.homedir(), ".hollywood-gateway-projects.json")
  const projectSessions = new Map<string, string>() // `${dir}|@|${channelId}:${conversationId}` → sessionID
  try {
    const raw = JSON.parse(fs.readFileSync(PROJ_STORE, "utf8")) as Record<string, string>
    for (const [k, v] of Object.entries(raw)) projectSessions.set(k, v)
  } catch {
    // first run
  }
  const saveProjects = () => {
    try {
      const tmp = PROJ_STORE + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(projectSessions), null, 2))
      fs.renameSync(tmp, PROJ_STORE)
    } catch (err) {
      console.error("Could not persist project session store:", err)
    }
  }
  const projKey = (dir: string, convKey: string) => `${dir}|@|${convKey}`

  // --- Permission / agent mode ----------------------------------------------
  // Five modes (like Claude Code's permission modes), mapped onto opencode's
  // existing primitives — a per-tool permission block + the agent used per
  // prompt (plan vs build). `auto` resolves per task (see Phase 4 / handleMessage).
  type Mode = "ask" | "auto-edit" | "plan" | "bypass" | "auto"
  type Perm = "allow" | "ask" | "deny"
  const MODE_PERMISSIONS: Record<Exclude<Mode, "auto">, Record<string, Perm>> = {
    // confirm before edits & bash
    ask: { external_directory: "ask", bash: "ask", read: "allow", write: "ask", edit: "ask", webfetch: "allow" },
    // edits run automatically; bash still asks
    "auto-edit": { external_directory: "allow", bash: "ask", read: "allow", write: "allow", edit: "allow", webfetch: "allow" },
    // read-only planning: no edits (the `plan` agent also blocks them)
    plan: { external_directory: "allow", bash: "ask", read: "allow", write: "deny", edit: "deny", webfetch: "allow" },
    // approve everything
    bypass: { external_directory: "allow", bash: "allow", read: "allow", write: "allow", edit: "allow", webfetch: "allow" },
  }

  // Migrate the legacy autoAllow boolean into the new mode.
  let mode: Mode = config.mode ?? (config.autoAllow ? "bypass" : "ask")
  // `autoAllow` (used by the reconciler) is now derived: bypass approves stragglers.
  let autoAllow = mode === "bypass"
  // Per-task resolved sub-mode for `auto` (sessionID → concrete mode). Phase 4.
  const autoResolved = new Map<string, Exclude<Mode, "auto">>()

  // The concrete mode driving permissions for a session right now.
  const effectiveMode = (sid?: string): Exclude<Mode, "auto"> =>
    mode === "auto" ? (sid && autoResolved.get(sid)) || "ask" : mode
  // The agent to run for a session: plan mode → "plan", everything else → "build".
  const agentForMode = (sid?: string): "plan" | "build" => (effectiveMode(sid) === "plan" ? "plan" : "build")
  const permissionBlock = () => MODE_PERMISSIONS[mode === "auto" ? "ask" : mode]

  const applyPermissionMode = () => {
    try {
      const p = path.join(DIRECTORY, "opencode.jsonc")
      const raw = fs.existsSync(p) ? readJsonc(p) : { $schema: "https://opencode.ai/config.json" }
      raw.permission = permissionBlock()
      fs.writeFileSync(p, JSON.stringify(raw, null, 2))
      log("engine", `Mode: ${mode}`)
    } catch (err) {
      console.error("Could not update opencode.jsonc:", err)
    }
  }
  applyPermissionMode()

  // --- Native MCP tools (browser, etc.) -------------------------------------
  // The opencode core already speaks MCP; we just register well-known servers
  // in opencode.jsonc so their tools show up natively to the model. Toggled via
  // /tools. The browser (Playwright MCP) is free and local — on by default.
  const mcpBin = (name: string) => fileURLToPath(new URL(`../bin/hollycode-${name}-mcp.ts`, import.meta.url))
  const imageMcpPath = mcpBin("image")
  const videoMcpPath = mcpBin("video")
  const visionMcpPath = mcpBin("vision")
  const MCP_CATALOG: Record<string, { label: string; type: "local"; command: string[]; needsKey?: string }> = {
    browser: {
      label: "Browser (Playwright) — navigate, click, read live pages",
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@latest"],
    },
    image: {
      label: "Image generation (FAL.ai) — needs FAL_KEY in the environment",
      type: "local",
      command: [process.execPath, "run", imageMcpPath],
      needsKey: "FAL_KEY",
    },
    video: {
      label: "Video generation (FAL.ai) — needs FAL_KEY in the environment",
      type: "local",
      command: [process.execPath, "run", videoMcpPath],
      needsKey: "FAL_KEY",
    },
    vision: {
      label: "Vision analysis (OpenAI-compatible) — needs VISION_API_KEY or OPENAI_API_KEY",
      type: "local",
      command: [process.execPath, "run", visionMcpPath],
    },
    videoanalyze: {
      label: "Video analysis (frames + vision) — needs VISION_API_KEY or OPENAI_API_KEY + ffmpeg",
      type: "local",
      command: [process.execPath, "run", mcpBin("videoanalyze")],
    },
    computeruse: {
      label: "Computer use (desktop control via Python/pyautogui)",
      type: "local",
      command: [process.execPath, "run", mcpBin("computeruse")],
    },
    homeassistant: {
      label: "Home Assistant (smart-home control) — needs HA_URL + HA_TOKEN",
      type: "local",
      command: [process.execPath, "run", mcpBin("homeassistant")],
      needsKey: "HA_TOKEN",
    },
    spotify: {
      label: "Spotify (playback, search, playlists) — needs SPOTIFY_TOKEN",
      type: "local",
      command: [process.execPath, "run", mcpBin("spotify")],
      needsKey: "SPOTIFY_TOKEN",
    },
  }
  // browser is free/local → on by default; the rest need a key/setup → off by default.
  const toolsEnabled: Record<string, boolean> = {
    browser: true,
    image: false,
    video: false,
    vision: false,
    videoanalyze: false,
    computeruse: false,
    homeassistant: false,
    spotify: false,
    ...(config.tools ?? {}),
  }

  const applyMcpConfig = (opts?: { force?: boolean }) => {
    try {
      const p = path.join(DIRECTORY, "opencode.jsonc")
      const raw = fs.existsSync(p) ? readJsonc(p) : { $schema: "https://opencode.ai/config.json" }
      const prev = (raw.mcp ?? {}) as Record<string, { enabled?: boolean } | undefined>
      const mcp: Record<string, unknown> = {}
      for (const [id, def] of Object.entries(MCP_CATALOG)) {
        // On startup (no force) preserve a toggle the user already made — the TUI
        // sidebar / `mcp` tool write `enabled` straight into this file. Only fall
        // back to the gateway default when the server has no prior enabled state.
        const prevEnabled = typeof prev[id]?.enabled === "boolean" ? prev[id]!.enabled : undefined
        const enabled = opts?.force || prevEnabled === undefined ? toolsEnabled[id] !== false : prevEnabled!
        mcp[id] = { type: def.type, command: def.command, enabled }
        toolsEnabled[id] = enabled
      }
      raw.mcp = mcp
      fs.writeFileSync(p, JSON.stringify(raw, null, 2))
      log("engine", `MCP tools: ${Object.keys(MCP_CATALOG).map((id) => `${id}=${toolsEnabled[id] !== false ? "on" : "off"}`).join(" ")}`)
    } catch (err) {
      console.error("Could not write MCP config:", err)
    }
  }
  applyMcpConfig()

  // Install the agent-facing tools (cronjob, recall, send_message, memory) so the
  // agent can use them when asked in natural language (the gateway watches their
  // inbox below). `memory` is self-contained and also works in the TUI.
  installAgentTools()

  // --- Boot server ----------------------------------------------------------
  log("engine", "Starting Hollywood Code server...")
  let server = await bootServer(DIRECTORY)
  let opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
  let opencodeV2 = createV2Client({ baseUrl: server.url })
  log("engine", `Server ready. Project directory: ${DIRECTORY}`)

  // --- Auto-detect default model --------------------------------------------
  let defaultModel: { providerID: string; modelID: string } | undefined
  // The free, always-available fallback (the host's own default — e.g.
  // opencode/big-pickle). When a pinned paid model fails (no credits / rate
  // limit), prompts auto-retry on this so the bot never dead-ends.
  let freeModel: { providerID: string; modelID: string } | undefined
  try {
    const prov = await opencode.client.config.providers()
    const defaults = prov.data?.default as Record<string, string> | undefined
    if (defaults) {
      const entries = Object.entries(defaults)
      const preferred = entries.find(([id]) => id === "opencode") ?? entries[0]
      if (preferred) freeModel = { providerID: preferred[0], modelID: preferred[1] }
    }
    // Honor a previously pinned model across restarts; otherwise use the free default.
    if (config.model && config.model !== "auto") {
      const parts = config.model.split("/")
      if (parts.length >= 2) defaultModel = { providerID: parts[0]!, modelID: parts.slice(1).join("/") }
    }
    if (!defaultModel) defaultModel = freeModel
    if (defaultModel)
      log(
        "engine",
        `Model: ${defaultModel.providerID}/${defaultModel.modelID}` +
          (freeModel ? ` (free fallback: ${freeModel.providerID}/${freeModel.modelID})` : ""),
      )
  } catch {
    log("engine", "Could not detect default model, using server default")
  }

  // --- Event subscription (status updates per conversation) -----------------
  // Map sessionID → the StatusHandle opened for that prompt
  const statusHandles = new Map<string, StatusHandle>()
  // Per-session tool lines for the working status
  const statusLines = new Map<string, string[]>()
  // The last responder seen for each session — used by the global reconciler so
  // permission/question prompts get delivered even after prompt() has returned.
  const activeResponders = new Map<string, Responder>()
  // Auto-memory: a hidden review session per conversation that silently decides
  // what to persist after each turn. Toggle with config.autoMemory / /automemory.
  let autoMemory = config.autoMemory ?? true
  const reviewSessions = new Map<string, string>()
  const recall = openRecallIndex() // FTS5 full-text search over past sessions
  // Tiered memory: WORKING = a small capped section in AGENTS.md (always in
  // context); LONG = every fact ever learned, in FTS5, OUT of the context —
  // injected per message via selective retrieval (ChatGPT-Memories style).
  const memory = openMemoryStore()
  const MEM_SCOPE_USER = "user"
  const WORKING_CAP_PROJECT = 40
  const WORKING_CAP_USER = 25
  // Managed sections: everything the auto-memory / /remember / agent memory
  // tool has been appending. The curator folds them into one lean section.
  const PROJECT_MEM_HEADERS = ["## Auto-memory", "## Memory", "## Memory (added via /remember)"]
  const USER_MEM_HEADER = "## About the user"

  // Personalities — a system-prompt flavor prepended to prompts when active.
  const PERSONALITIES: Record<string, string> = {
    default: "",
    concise: "Be terse and direct. Answer in as few words as correctness allows; skip preamble.",
    mentor: "Explain your reasoning as you go, teaching the user the why behind each step, patiently.",
    pirate: "Respond in the voice of a witty pirate, while keeping all technical content fully correct.",
    pair: "Act as a hands-on pair-programmer: think out loud, propose small steps, confirm before big changes.",
  }
  let personality = config.personality && PERSONALITIES[config.personality] !== undefined ? config.personality : "default"

  let eventAbort = new AbortController()
  // sessionID → last time the model produced ANY output. Lets promptWithFallback
  // tell "slow but working" (streaming reasoning/text/tools) apart from "truly
  // stalled" (a quota/credit error the SDK retries with no output), so it only
  // falls back on a real stall — never on a long-running task.
  const lastActivity = new Map<string, number>()
  // REAL sessionID (parent OR subagent child) → the tool currently RUNNING.
  // Keyed by the session that actually runs the tool: a child completing its own
  // tool used to erase the PARENT's entry, which killed the "a running tool means
  // work" keep-alive and let the watchdog abort a live subagent mid-patch.
  const statusRunning = new Map<string, string>()
  // sessionID → hard provider-limit error text (credits/quota/rate) detected in
  // the live event stream via "retry" parts. This is the ONLY trigger allowed to
  // abort a turn early / engage the free fallback — silence never is.
  const hardLimitHit = new Map<string, string>()
  // sessionID → last raw provider error seen in the stream (any kind). When a
  // turn dies silently, this is surfaced instead of a generic "went silent" —
  // so a credit-limit that the SDK retried forever is NAMED to the user.
  const lastStreamError = new Map<string, string>()
  // child sessionID → parent sessionID. Subagents (task tool) run in CHILD
  // sessions; mapping them back lets their tool activity show in the parent's
  // Telegram status (and counts as activity for the stall watcher).
  const childToParent = new Map<string, string>()
  // Children whose cast model was already announced in the parent status (once
  // per subagent — the user verifies the router dispatched the right double).
  const childModelAnnounced = new Set<string>()
  // child sessionID → "provider/model · variant", for the live work report.
  const childModel = new Map<string, string>()
  // owner sessionID → when the current turn started (elapsed time in reports).
  const turnStarted = new Map<string, number>()
  // owner sessionID → files created/edited/deleted this turn (relative paths).
  const turnFiles = new Map<string, Map<string, string>>()
  // owner sessionID → the request that started the running turn (context for the
  // side chat, so the agent can talk about what its subagents are doing).
  const turnRequest = new Map<string, string>()
  // conversation key → side-chat session used while the main agent supervises.
  const sideSessions = new Map<string, string>()
  // Coalesce status edits: Telegram allows ~1 edit/sec per message, and a burst
  // of quick tool completions used to fire an edit per event — 429s and dropped
  // updates. At most one edit per 1.2s per session, with a trailing flush so the
  // final state always lands.
  const statusEditState = new Map<string, { last: number; timer?: ReturnType<typeof setTimeout>; text: string }>()
  const pushStatusEdit = (sessionID: string, text: string) => {
    const st = statusEditState.get(sessionID) ?? { last: 0, text: "" }
    st.text = text
    statusEditState.set(sessionID, st)
    const since = Date.now() - st.last
    if (since >= 1200) {
      st.last = Date.now()
      const h = statusHandles.get(sessionID)
      if (h) void h.update(text).catch(() => {})
      return
    }
    if (!st.timer) {
      st.timer = setTimeout(() => {
        st.timer = undefined
        st.last = Date.now()
        const h = statusHandles.get(sessionID)
        if (h) void h.update(st.text).catch(() => {})
      }, 1200 - since)
    }
  }
  // Every session that belongs to one conversation turn: the parent plus every
  // subagent it spawned. Used for both rendering and the "is work alive?" check.
  const sessionsOf = (owner: string): string[] => {
    const out = [owner]
    for (const [child, parent] of childToParent) if (parent === owner) out.push(child)
    return out
  }
  /** True while the parent or ANY of its subagents has a tool in flight. */
  const hasActiveWork = (owner: string): boolean => sessionsOf(owner).some((s) => statusRunning.has(s))
  const fmtElapsed = (ms: number) => {
    const s = Math.round(ms / 1000)
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
  }
  /** The status message body: recent lines + every tool currently running. */
  const renderStatus = (owner: string, note?: string): string => {
    const lines = statusLines.get(owner) ?? []
    const running = sessionsOf(owner)
      .map((s) => statusRunning.get(s))
      .filter((x): x is string => !!x)
    return "🎬 working...\n" + [...lines.slice(-8), ...running, ...(note ? [note] : [])].join("\n")
  }
  // ── Live file feed ────────────────────────────────────────────────────────
  // Every file the agent (or a subagent) creates/edits/deletes is reported in
  // the chat as it happens, so the user follows the build from start to finish.
  // Batched ~2.5s so a burst of writes becomes ONE message instead of flooding.
  const FILE_VERB: Record<string, { icon: string; verb: string }> = {
    add: { icon: "📄", verb: "created" },
    edit: { icon: "📝", verb: "edited" },
    delete: { icon: "🗑", verb: "deleted" },
  }
  const fileFeed = new Map<string, { pending: Map<string, string>; timer?: ReturnType<typeof setTimeout> }>()
  const noteFiles = (owner: string, entries: Array<{ path: string; type: string }>) => {
    if (!entries.length) return
    const all = turnFiles.get(owner) ?? new Map<string, string>()
    for (const e of entries) all.set(e.path, e.type)
    turnFiles.set(owner, all)

    const st = fileFeed.get(owner) ?? { pending: new Map<string, string>() }
    for (const e of entries) st.pending.set(e.path, e.type)
    fileFeed.set(owner, st)
    if (st.timer) return
    st.timer = setTimeout(() => {
      st.timer = undefined
      const list = [...st.pending.entries()]
      st.pending.clear()
      const r = activeResponders.get(owner)
      if (!r || !list.length) return
      const rows = list.slice(0, 20).map(([p, t]) => {
        const v = FILE_VERB[t] ?? FILE_VERB.edit!
        return `${v.icon} ${v.verb}: ${p}`
      })
      const more = list.length > 20 ? `\n…and ${list.length - 20} more` : ""
      void r.sendText(rows.join("\n") + more).catch(() => {})
    }, 2500)
  }
  /** Files touched by a completed tool part (write/edit/patch shapes differ). */
  const filesFromTool = (tool: string, st: any): Array<{ path: string; type: string }> => {
    const rel = (p: string) => {
      const s = String(p ?? "")
      if (!s) return ""
      const base = DIRECTORY.replace(/\\/g, "/")
      const norm = s.replace(/\\/g, "/")
      return norm.startsWith(base) ? norm.slice(base.length).replace(/^\//, "") : norm
    }
    // apply_patch / patch: metadata.files[] carries relativePath + type.
    const meta = st?.metadata?.files
    if (Array.isArray(meta) && meta.length) {
      return meta
        .map((f: any) => ({ path: f.relativePath || rel(f.filePath), type: String(f.type ?? "edit") }))
        .filter((f: any) => f.path)
    }
    if (tool === "write" || tool === "edit") {
      const p = rel(st?.input?.filePath)
      if (p) return [{ path: p, type: tool === "write" ? "add" : "edit" }]
    }
    return []
  }

  // ── Live work report ──────────────────────────────────────────────────────
  // While a turn is running the conversation used to be frozen: any message
  // waited in the queue, so the user couldn't even ask what the subagents were
  // doing. This answers that question INSTANTLY from real state (no model call,
  // no cost, no interference with the work in flight).
  const liveWorkReport = (owner: string): string => {
    const started = turnStarted.get(owner)
    const head = started ? `🎬 Still working — ${fmtElapsed(Date.now() - started)} elapsed` : "🎬 Still working"
    const out: string[] = [head]

    const children = sessionsOf(owner).filter((s) => s !== owner)
    if (children.length) {
      out.push("", `🤖 Subagents (${children.length}):`)
      for (const c of children) {
        const running = statusRunning.get(c)
        out.push(`  • ${childModel.get(c) ?? "casting…"} — ${running ? running.replace(/^⏳ (↳ 🤖 )?/, "") : "thinking/writing…"}`)
      }
    }
    const own = statusRunning.get(owner)
    if (own) out.push("", `Main agent: ${own.replace(/^⏳ /, "")}`)
    else if (children.length) out.push("", "Main agent: waiting for the subagents.")

    const files = turnFiles.get(owner)
    if (files?.size) {
      const names = [...files.keys()]
      out.push("", `📁 Files so far (${names.length}): ${names.slice(-8).join(", ")}${names.length > 8 ? " …" : ""}`)
    }
    const lines = statusLines.get(owner) ?? []
    if (lines.length) out.push("", "Recent steps:", ...lines.slice(-5))
    out.push("", "(Live status — the work continues; nothing was interrupted.)")
    return out.join("\n")
  }
  /**
   * True when the main agent is only SUPERVISING: it dispatched subagents and is
   * itself idle (no tool of its own besides the `task` call it is blocked on).
   * In that state the user can keep talking to it about anything; when the agent
   * is doing the work itself, messages queue instead.
   */
  const parentSupervising = (owner: string): boolean => {
    if (!statusHandles.has(owner)) return false
    const children = sessionsOf(owner).filter((s) => s !== owner)
    if (!children.length) return false
    const own = statusRunning.get(owner)
    return !own || /\btask\b/.test(own)
  }
  // Questions the gateway can answer itself while the agent is busy (PT + EN).
  const STATUS_QUESTION =
    /\b(o que|oque|que)\b.{0,40}\b(faz|fazendo|acontec\w*|rolando|andando)|\bwhat\b.{0,40}\b(doing|happening|going on)|\b(status|progresso|progress|andamento)\b|\b(ainda|still)\b.{0,25}\b(trabalh\w*|working|rodando|running|ativo)|\b(terminou|acabou|finalizou|pronto|done|finished|ready)\b\??$|\bquanto (falta|tempo|demora)\b|\bcom[oó] (est[aá]|vai|ta|t[aá])\b/i

  const clearStatusEdit = (sessionID: string) => {
    const st = statusEditState.get(sessionID)
    if (st?.timer) clearTimeout(st.timer)
    statusEditState.delete(sessionID)
  }
  const startEvents = () => {
    eventAbort.abort()
    eventAbort = new AbortController()
    const sig = eventAbort.signal
    void (async () => {
      // The SSE stream can drop silently (network hiccup, server pause). Without
      // reconnection, tool progress stops reaching Telegram ("working..." forever)
      // AND lastActivity goes stale, so the stall watcher falsely kills a WORKING
      // model. Reconnect forever with backoff; on every (re)connect bump active
      // sessions so blind time never counts as model inactivity.
      const compactStarted = new Set<string>()
      const compactEnded = new Set<string>()
      let attempt = 0
      while (!sig.aborted) {
        try {
          const events = await opencode.client.event.subscribe()
          attempt = 0
          log("engine", "event stream connected")
          for (const k of statusHandles.keys()) lastActivity.set(k, Date.now())
          for await (const event of events.stream) {
            if (sig.aborted) break

        // Subagent sessions: session events carry parentID — remember the link
        // so a child's activity is attributed to the parent conversation.
        if (event.type === "session.updated" || event.type === "session.created") {
          const sInfo = (event.properties as any)?.info
          if (sInfo?.parentID && sInfo?.id) childToParent.set(sInfo.id, sInfo.parentID)
        }

        // Any message event for a session = its model is alive and producing
        // output. Stamp it so the stall watcher won't abort a working long task.
        // Child activity stamps the PARENT too (subagent working = turn alive).
        const evSid =
          (event.properties as any)?.info?.sessionID ?? (event.properties as any)?.part?.sessionID
        if (evSid) {
          lastActivity.set(evSid, Date.now())
          const evParent = childToParent.get(evSid)
          if (evParent) lastActivity.set(evParent, Date.now())
        }

        // Auto-compaction notice. The engine compacts automatically when the
        // context crosses the configured threshold (default 95%, like Claude
        // Code). Surface it so the pause is understood as the bot keeping itself
        // within the model's context limit. The compaction produces an assistant
        // message flagged summary/compaction.
        if (event.type === "message.updated") {
          const info = (event.properties as any).info
          // Announce WHICH MODEL each subagent runs, once, in the parent status —
          // so the user can verify the router dispatched the right double.
          if (info?.role === "assistant" && info.modelID && childToParent.has(info.sessionID)) {
            const parent0 = childToParent.get(info.sessionID)!
            const variant0 = info.variant && info.variant !== "default" ? ` · ${info.variant}` : ""
            childModel.set(info.sessionID, `${info.providerID}/${info.modelID}${variant0}`)
            if (statusHandles.has(parent0) && !childModelAnnounced.has(info.sessionID)) {
              childModelAnnounced.add(info.sessionID)
              const lines0 = statusLines.get(parent0) ?? []
              lines0.push(`🤖 subagent cast: ${childModel.get(info.sessionID)}`)
              statusLines.set(parent0, lines0)
              pushStatusEdit(parent0, renderStatus(parent0))
            }
          }
          // Assistant-message errors carry the REAL provider failure (credits,
          // quota, auth…). Record it so a silent death can be named, and stamp
          // hard limits so the watcher aborts + falls back per policy.
          if (info?.role === "assistant" && info.error) {
            const errTxt = String(info.error?.data?.message ?? info.error?.message ?? info.error?.name ?? "")
            if (errTxt) {
              const owner0 = childToParent.get(info.sessionID) ?? info.sessionID
              lastStreamError.set(owner0, errTxt)
              if (isHardLimit(errTxt)) hardLimitHit.set(owner0, errTxt)
            }
          }
          const isSummary =
            info &&
            info.role === "assistant" &&
            (info.summary === true || info.mode === "compaction" || info.agent === "compaction")
          if (isSummary) {
            const r = activeResponders.get(info.sessionID)
            if (r) {
              if (!compactStarted.has(info.id)) {
                compactStarted.add(info.id)
                await r
                  .sendText("📦 Auto-compacting — context reached the limit; summarizing older messages to keep going…")
                  .catch(() => {})
              }
              if ((info.finish || info.error) && !compactEnded.has(info.id)) {
                compactEnded.add(info.id)
                await r
                  .sendText(
                    info.error
                      ? "⚠️ Auto-compaction hit an error — try /new if the session is too large."
                      : "✅ Auto-compacted — context freed, continuing.",
                  )
                  .catch(() => {})
              }
            }
          }
          continue
        }

        if (event.type !== "message.part.updated") continue
        const part = event.properties.part as ToolPart
        // Hard provider-limit errors (credits/quota/rate) surface live as "retry"
        // parts while the SDK retries in a loop with no output. Stamp them — this
        // is the ONLY signal that may abort a turn early (a busy tool is silent,
        // so silence alone must never be treated as failure).
        if ((part as any).type === "retry") {
          const errTxt = String((part as any).error?.data?.message ?? (part as any).error?.message ?? "")
          if (errTxt) {
            const owner0 = childToParent.get(part.sessionID) ?? part.sessionID
            lastStreamError.set(owner0, errTxt)
            if (isHardLimit(errTxt)) hardLimitHit.set(owner0, errTxt)
          }
          continue
        }
        if (part.type !== "tool") continue
        // Subagent tools render into the PARENT's status, prefixed — so the user
        // sees what the doubles are doing instead of a frozen "working".
        const owner = statusHandles.has(part.sessionID) ? part.sessionID : childToParent.get(part.sessionID)
        if (!owner) continue
        const handle = statusHandles.get(owner)
        if (!handle) continue
        const sub = owner !== part.sessionID ? "↳ 🤖 " : ""
        const lines = statusLines.get(owner) ?? []
        const st: any = part.state
        // Keyed by the REAL session, so a child's completion can't clear the
        // parent's still-running `task` tool (that erasure caused the abort).
        if (st.status === "running") {
          // Live line for the tool in flight — long bash/computeruse steps show
          // up immediately instead of only after they complete.
          statusRunning.set(part.sessionID, `⏳ ${sub}${part.tool}${st.title ? ` — ${st.title}` : "…"}`)
        } else if (st.status === "completed") {
          lines.push(`✓ ${sub}${part.tool} — ${st.title}`)
          statusLines.set(owner, lines)
          statusRunning.delete(part.sessionID)
          noteFiles(owner, filesFromTool(part.tool, st)) // live file feed
        } else if (st.status === "error") {
          lines.push(`✗ ${sub}${part.tool} — ${st.error ?? "error"}`)
          statusLines.set(owner, lines)
          statusRunning.delete(part.sessionID)
        } else {
          continue
        }
        pushStatusEdit(owner, renderStatus(owner))
      }
          if (sig.aborted) break
          log("engine", "event stream ended — reconnecting")
        } catch (e: any) {
          if (sig.aborted) break
          log("engine", `event stream error: ${e?.message ?? e} — reconnecting`)
        }
        // We were blind while the stream was down — bump active sessions so the
        // stall watcher never mistakes blind time for model inactivity.
        for (const k of statusHandles.keys()) lastActivity.set(k, Date.now())
        attempt++
        await new Promise((r) => setTimeout(r, Math.min(15_000, 1_000 * attempt)))
      }
    })()
  }
  startEvents()

  // --- Pending permission/question tracking ---------------------------------
  const notified = new Set<string>()

  const replyPermission = async (
    p: { api: "v1" | "v2"; sessionID: string; requestID: string },
    reply: "once" | "always" | "reject",
  ) => {
    if (p.api === "v1") {
      await opencodeV2.permission.reply({ requestID: p.requestID, reply }).catch(() => {})
    } else {
      await opencodeV2.v2.session.permission.reply({ sessionID: p.sessionID, requestID: p.requestID, reply }).catch(() => {})
    }
  }

  const resolvePending = async (sid: string, responder: Responder) => {
    // The de-dup set only ever grew (every permission/question id, forever).
    // It only needs to cover in-flight requests — reset when it gets large.
    if (notified.size > 2000) notified.clear()
    // v1 global permissions
    const globalPerms = await opencodeV2.permission.list({}).catch(() => null)
    const v1Requests: any[] = (globalPerms?.data as any) ?? []
    for (const r of v1Requests) {
      if (r.sessionID !== sid) continue
      if (autoApproves(sid, r.permission as string)) {
        await opencodeV2.permission.reply({ requestID: r.id, reply: "always" }).catch(() => {})
        continue
      }
      if (notified.has(r.id)) continue
      notified.add(r.id)
      const detail = [
        r.permission,
        ...(r.patterns?.slice(0, 5) ?? []),
        r.metadata?.filepath ? `📄 ${r.metadata.filepath}` : "",
      ].filter(Boolean).join("\n")
      responder
        .askPermission({ action: r.permission as string, detail })
        .then((decision) => replyPermission({ api: "v1", sessionID: r.sessionID, requestID: r.id }, decision))
        .catch(() => {})
    }

    // v2 session-scoped permissions
    const perms = await opencodeV2.v2.session.permission.list({ sessionID: sid }).catch(() => null)
    const v2Requests: any[] = (perms?.data as any)?.data ?? []
    for (const r of v2Requests) {
      if (autoApproves(sid, r.action as string)) {
        await opencodeV2.v2.session.permission.reply({ sessionID: sid, requestID: r.id, reply: "always" }).catch(() => {})
        continue
      }
      if (notified.has(r.id)) continue
      notified.add(r.id)
      const detail = [r.action, ...(r.resources?.slice(0, 5) ?? [])].filter(Boolean).join("\n")
      responder
        .askPermission({ action: r.action as string, detail })
        .then((decision) => replyPermission({ api: "v2", sessionID: sid, requestID: r.id }, decision))
        .catch(() => {})
    }

    // questions
    const all: any = await opencodeV2.question.list({}).catch(() => null)
    const qs: any[] = all?.data ?? []
    for (const q of qs) {
      if (q.sessionID !== sid) continue
      const first = q.questions?.[0]
      // A `question` is the agent explicitly asking the USER to choose — always
      // deliver it (even in bypass mode, which only auto-approves permissions).
      // The only case we can't render is a question with no options at all, so
      // that degenerate case still auto-answers to avoid freezing the turn.
      if (!first?.options?.length) {
        const answers: string[][] =
          q.questions?.map((qq: any) => (qq.options?.[0]?.label ? [qq.options[0].label] : ["ok"])) ?? []
        await opencodeV2.question.reply({ requestID: q.id, answers }).catch(() => {})
        continue
      }
      if (notified.has(q.id)) continue
      notified.add(q.id)
      const options: string[] = (first.options as any[]).slice(0, 8).map((o: any, i: number) =>
        String(o.label || `Option ${i + 1}`),
      )
      responder
        .askQuestion({ question: first.question as string, options })
        .then((chosen) => {
          const questions: any[] = q.questions ?? []
          const idx = options.indexOf(chosen)
          const answers: string[][] = questions.map((qq: any, i: number) => {
            const label = i === 0 ? qq.options?.[idx]?.label : qq.options?.[0]?.label
            return [label || "ok"]
          })
          return opencodeV2.question.reply({ requestID: q.id, answers }).catch(() => {})
        })
        .catch(() => {})
    }
  }

  // Clear any pending permission/question for a session WITHOUT losing context
  // (used by /stop): deny pending permissions, answer pending questions with
  // the first option, so a stuck turn unblocks instead of needing /new.
  const clearPending = async (sid: string) => {
    const gp = await opencodeV2.permission.list({}).catch(() => null)
    for (const r of (((gp?.data as any) ?? []) as any[])) {
      if (r.sessionID === sid) await opencodeV2.permission.reply({ requestID: r.id, reply: "reject" }).catch(() => {})
    }
    const sp = await opencodeV2.v2.session.permission.list({ sessionID: sid }).catch(() => null)
    for (const r of (((sp?.data as any)?.data ?? []) as any[])) {
      await opencodeV2.v2.session.permission.reply({ sessionID: sid, requestID: r.id, reply: "reject" }).catch(() => {})
    }
    const qs = await opencodeV2.question.list({}).catch(() => null)
    for (const q of (((qs?.data as any) ?? []) as any[])) {
      if (q.sessionID !== sid) continue
      const answers: string[][] = q.questions?.map((qq: any) => (qq.options?.[0]?.label ? [qq.options[0].label] : ["ok"])) ?? []
      await opencodeV2.question.reply({ requestID: q.id, answers }).catch(() => {})
    }
  }

  // Global safety-net reconciler: every few seconds, deliver any pending
  // permission/question to the LAST responder of each active conversation.
  // This decouples delivery from a single prompt()'s lifecycle — so buttons
  // reliably arrive even when prompt() returns while a question/permission is
  // still pending (which used to freeze the session and force /new).
  const reconciler = setInterval(() => {
    for (const [sid, responder] of activeResponders) {
      void resolvePending(sid, responder)
    }
  }, 2500)

  // Skill curator: archive auto-created skills not touched in N days (never
  // deletes — moves to auto/_archived, recoverable). Mirrors Hermes' curator.
  const SKILLS_AUTO = path.join(os.homedir(), ".config", "opencode", "skills", "auto")
  const curateSkills = (): string[] => {
    const archived: string[] = []
    try {
      if (!fs.existsSync(SKILLS_AUTO)) return archived
      const maxAgeMs = (config.skillMaxAgeDays ?? 30) * 86400000
      const archiveDir = path.join(SKILLS_AUTO, "_archived")
      for (const name of fs.readdirSync(SKILLS_AUTO)) {
        if (name === "_archived") continue
        const skillMd = path.join(SKILLS_AUTO, name, "SKILL.md")
        if (!fs.existsSync(skillMd)) continue
        if (Date.now() - fs.statSync(skillMd).mtimeMs > maxAgeMs) {
          fs.mkdirSync(archiveDir, { recursive: true })
          fs.renameSync(path.join(SKILLS_AUTO, name), path.join(archiveDir, name))
          archived.push(name)
        }
      }
    } catch (err: any) {
      log("curator", `failed: ${err?.message ?? err}`)
    }
    if (archived.length) log("curator", `archived ${archived.length} unused skill(s): ${archived.join(", ")}`)
    return archived
  }
  // --- Memory curator — keeps the WORKING memory small and fresh -------------
  // Folds every managed AGENTS.md memory section into ONE lean deduplicated
  // section (≤ cap bullets), archiving EVERYTHING into the long-term store
  // first (nothing is ever lost — it just leaves the context). The first run
  // digests the accumulated backlog (hundreds of bullets → dozens).
  let curatorSession: string | undefined
  const compressViaLLM = async (bullets: string[], cap: number, flavor: string): Promise<string[] | undefined> => {
    try {
      if (!curatorSession) {
        const created = await opencode.client.session.create({ body: { title: "memory curator" } })
        if (created.error || !created.data) return undefined
        curatorSession = created.data.id
      }
      const prompt =
        `You are a memory curator. Below are ${bullets.length} remembered facts (${flavor}). ` +
        `Rewrite them as AT MOST ${cap} concise bullets: merge duplicates and near-duplicates, keep the most ` +
        `important, recent and durable facts, and drop obsolete or one-off details. Output ONLY the bullets, ` +
        `one per line, each starting with "- ". No headers, no commentary.\n\n` +
        bullets.map((b) => `- ${b}`).join("\n")
      const res = await opencode.client.session
        .prompt({ path: { id: curatorSession }, body: { parts: [{ type: "text", text: prompt }] } as any })
        .catch(() => null)
      const out = (((res as any)?.data?.parts ?? []) as any[])
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
      const parsed = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2).trim())
        .filter(Boolean)
      if (parsed.length >= 1 && parsed.length <= cap * 1.5) return parsed.slice(0, cap)
      return undefined
    } catch {
      return undefined
    }
  }
  const curateMemoryFile = async (
    file: string,
    headers: string[],
    keepHeader: string,
    scope: string,
    cap: number,
    flavor: string,
  ) => {
    let content = ""
    try {
      content = fs.readFileSync(file, "utf8")
    } catch {
      return
    }
    const all: string[] = []
    for (const h of headers) all.push(...sectionBullets(content, h))
    if (!all.length) return
    for (const b of all) memory.add(scope, b) // archive FIRST — nothing is lost
    if (all.length <= cap && headers.length === 1) return // already lean
    const unique = [...new Set(all)]
    const compressed = (await compressViaLLM(unique, cap, flavor)) ?? unique.slice(-cap)
    for (const h of headers) content = removeSection(content, h)
    content = writeSection(content, keepHeader, compressed)
    fs.writeFileSync(file, content)
    log("memory", `curated ${flavor}: ${all.length} → ${compressed.length} working bullets (long-term: ${memory.count(scope)})`)
  }
  const curateMemory = async () => {
    await curateMemoryFile(
      path.join(DIRECTORY, "AGENTS.md"),
      PROJECT_MEM_HEADERS,
      "## Auto-memory",
      DIRECTORY,
      WORKING_CAP_PROJECT,
      "project memory",
    )
    await curateMemoryFile(
      path.join(os.homedir(), ".config", "opencode", "AGENTS.md"),
      [USER_MEM_HEADER],
      USER_MEM_HEADER,
      MEM_SCOPE_USER,
      WORKING_CAP_USER,
      "user profile",
    )
  }
  // First curation shortly after boot (digests the backlog), then every 6h.
  const memoryBootTimer = setTimeout(() => void curateMemory(), 90_000)

  // Runs every 6h while idle (config.skillCurator !== false).
  const curatorTimer = setInterval(() => {
    if (config.skillCurator !== false) curateSkills()
    void curateMemory()
  }, 6 * 60 * 60 * 1000)

  // --- Session helpers ------------------------------------------------------
  const sessionKey = (channelId: string, conversationId: string) => `${channelId}:${conversationId}`

  const getOrCreateSession = async (channelId: string, conversationId: string): Promise<string | undefined> => {
    const key = sessionKey(channelId, conversationId)
    const existing = sessionMap.get(key)
    if (existing) return existing
    const created = await opencode.client.session.create({ body: { title: `Gateway ${channelId}:${conversationId}` } })
    if (created.error || !created.data) {
      console.error("Failed to create session:", created.error)
      return undefined
    }
    sessionMap.set(key, created.data.id)
    projectSessions.set(projKey(DIRECTORY, key), created.data.id)
    saveStore()
    saveProjects()
    return created.data.id
  }

  const currentSession = (channelId: string, conversationId: string) =>
    sessionMap.get(sessionKey(channelId, conversationId))

  // Reverse of sessionMap: find which chat a session belongs to (used by the
  // agent cron tool to deliver scheduled jobs back to the right conversation).
  const chatForSession = (sid: string) => {
    for (const [key, value] of sessionMap) {
      if (value === sid) {
        const i = key.indexOf(":")
        return { channelId: key.slice(0, i), conversationId: key.slice(i + 1) }
      }
    }
    return undefined
  }

  // Watch the agent cron inbox: when the agent's cronjob tool files a request,
  // create/list/remove the job on the (gateway-owned) scheduler.
  const cronInboxTimer = setInterval(() => {
    try {
      processAgentInbox({
        scheduler,
        recall,
        chatForSession,
        deliver,
        deliverVoice,
        deliverImage,
        speak: speaker ? (t: string) => speaker!.synthesize(t) : undefined,
        log,
      })
    } catch {
      /* best-effort */
    }
  }, 2000)

  const syncModelToFile = (model: string) => {
    try {
      const p = path.join(DIRECTORY, "opencode.jsonc")
      const raw = readJsonc(p)
      raw.model = model
      fs.writeFileSync(p, JSON.stringify(raw, null, 2))
    } catch { /* best-effort */ }
  }

  // --- switchDir (for /move and /autoallow restart) -------------------------
  const switchDir = async (dir: string, responder: Responder) => {
    dir = path.resolve(dir)
    if (!fs.existsSync(dir)) {
      await responder.sendText("⚠️ Directory does not exist.").catch(() => {})
      return
    }
    // Remember the session(s) of the project we're leaving, so /move back resumes it.
    for (const [key, sidv] of sessionMap) projectSessions.set(projKey(DIRECTORY, key), sidv)
    saveProjects()
    DIRECTORY = dir
    config.directory = dir
    saveGatewayConfig(config)
    const cfgPath = path.join(dir, "opencode.jsonc")
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            permission: { external_directory: "allow", bash: "allow", read: "allow", write: "allow" },
          },
          null,
          2,
        ),
      )
    }
    // Bound any single async step so a slow/unreachable call can never freeze
    // the command (which, on a single-threaded adapter, freezes the whole bot).
    const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))])

    let resumed = 0
    try {
      log("engine", `switchDir: → ${dir}`)
      try { server.close() } catch { /* already gone */ }
      sessionMap.clear()
      server = await bootServer(DIRECTORY)
      opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
      opencodeV2 = createV2Client({ baseUrl: server.url })
      startEvents()
      log("engine", `switchDir: server rebooted at ${server.url}`)

      // Restore the last session(s) used in this project (if they still exist),
      // so you pick up where you left off instead of starting fresh.
      const prefix = projKey(DIRECTORY, "")
      for (const [pkey, sidv] of projectSessions) {
        if (!pkey.startsWith(prefix)) continue
        const convKey = pkey.slice(prefix.length)
        const ok = await withTimeout(
          opencode.client.session.get({ path: { id: sidv } }).then((r) => !!r.data).catch(() => false),
          3000,
          false,
        )
        if (ok) {
          sessionMap.set(convKey, sidv)
          resumed++
        }
      }
      saveStore()
      log("engine", `switchDir: restored ${resumed} session(s)`)

      const prov = await withTimeout(opencode.client.config.providers(), 5000, null as any)
      const defaults = prov?.data?.default as Record<string, string> | undefined
      if (defaults) {
        const preferred = Object.entries(defaults).find(([id]) => id === "opencode") ?? Object.entries(defaults)[0]
        if (preferred) {
          freeModel = { providerID: preferred[0], modelID: preferred[1] }
          // keep a pinned model across /move; only adopt the free default in auto mode
          if (config.model === "auto" || !config.model) defaultModel = freeModel
        }
      }
    } catch (err: any) {
      log("engine", `switchDir failed: ${err?.message ?? err}`)
      await responder.sendText(`⚠️ Could not switch to ${dir}: ${err?.message ?? err}`).catch(() => {})
      return
    }
    await responder
      .sendText(`✅ Switched to ${dir}${resumed ? "\n🧵 Resumed your last session here." : ""}`)
      .catch(() => {})
  }

  // Reboot the embedded server IN PLACE (same directory, same sessions). The
  // opencode server reads config once at boot into an InstanceState, so a config
  // change (e.g. /autocompact) only takes effect after a reboot. Unlike switchDir
  // this preserves the in-memory sessionMap so the active conversation continues
  // seamlessly (sessions live on disk and reload by id under the new server).
  const reloadServer = async (): Promise<boolean> => {
    try {
      try { server.close() } catch { /* already gone */ }
      server = await bootServer(DIRECTORY)
      opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
      opencodeV2 = createV2Client({ baseUrl: server.url })
      startEvents()
      log("engine", `reloadServer: rebooted at ${server.url}`)
      return true
    } catch (err: any) {
      log("engine", `reloadServer failed: ${err?.message ?? err}`)
      return false
    }
  }

  // Switch the permission/agent mode. Writes the mode's permission block and
  // reboots the server so it takes effect (the agent is applied per-prompt).
  const applyMode = async (m: Mode): Promise<boolean> => {
    mode = m
    autoAllow = mode === "bypass"
    config.mode = mode
    config.autoAllow = autoAllow // keep legacy field in sync
    saveGatewayConfig(config)
    applyPermissionMode()
    return reloadServer()
  }

  const MODE_LABELS: Record<Mode, string> = {
    ask: "🙋 ask — confirm before edits & bash",
    "auto-edit": "✍️ auto-edit — edits run automatically, bash asks",
    plan: "📋 plan — read-only, no edits",
    bypass: "⚡ bypass — approve everything",
    auto: "🤖 auto — best mode chosen per task",
  }

  // --- Auto mode: classify a task into a concrete sub-mode (hybrid) ----------
  // Risky/destructive → ask; clear edit → auto-edit; exploration/question → plan.
  const AUTO_SENSITIVE =
    /\b(delete|deleting|remove|removing|\brm\b|drop\b|truncate|git\s+push|force[-\s]?push|deploy|publish|production|\bprod\b|\.env\b|secret|credential|password|api[\s-]?key|token|migrat(e|ion)|format\s+(the\s+)?(disk|drive)|apag|delet|remov|destr[oó])/i
  const AUTO_EDIT =
    /\b(fix|add|change|implement|refactor|rename|update|create|write|edit|build|make|replace|install|configure|set\s?up|generate|append|insert|corrig|adicion|cria|criar|muda|mudar|implementa|refatora|atualiz|escrev|gera)/i
  const AUTO_PLAN =
    /(\?\s*$)|\b(how|why|what|which|where|when|explain|investigate|research|plan|design|should\s+i|best|review|analy[sz]e|understand|compare|recommend|como|por\s?qu|o\s?que|qual|onde|quando|explica|investiga|planej|analis|entend|revis|compara|recomend|deveria|devo)/i

  // Returns a concrete mode, or undefined when ambiguous (→ cheap model decides).
  const classifyHeuristic = (text: string): Exclude<Mode, "auto" | "bypass"> | undefined => {
    const t = text.trim()
    if (!t) return "ask"
    if (AUTO_SENSITIVE.test(t)) return "ask"
    const planLike = AUTO_PLAN.test(t)
    const editLike = AUTO_EDIT.test(t)
    if (planLike && editLike) return undefined
    if (planLike) return "plan"
    if (editLike) return "auto-edit"
    return undefined
  }

  // Cheap-model classifier for the ambiguous minority. Best-effort; defaults to
  // the safe "ask" on any failure. Uses a throwaway session so it never pollutes
  // the user's conversation context.
  const classifyModel = async (text: string): Promise<Exclude<Mode, "auto" | "bypass">> => {
    const fb = freeModel ?? defaultModel
    if (!fb) return "ask"
    let tmpSid: string | undefined
    try {
      const created = await opencode.client.session.create({ body: {} as any }).catch(() => null)
      tmpSid = (created?.data as any)?.id
      if (!tmpSid) return "ask"
      const instruction =
        "You are a router. Classify the request into ONE word: " +
        "PLAN (wants analysis/exploration/a plan, no file changes), " +
        "EDIT (wants clear code/file changes safe to apply automatically), or " +
        "ASK (risky or destructive changes needing confirmation). " +
        "Reply with ONLY one word: PLAN, EDIT, or ASK.\n\nRequest:\n" +
        text
      const r = await Promise.race([
        opencode.client.session.prompt({
          path: { id: tmpSid },
          body: { parts: [{ type: "text", text: instruction }], model: fb, agent: "build" } as any,
        }),
        new Promise((res) => setTimeout(() => res(null), 12_000)),
      ])
      const out = replyTextOf(r).toUpperCase()
      if (out.includes("EDIT")) return "auto-edit"
      if (out.includes("PLAN")) return "plan"
      return "ask"
    } catch {
      return "ask"
    } finally {
      if (tmpSid) await opencode.client.session.delete({ path: { id: tmpSid } }).catch(() => {})
    }
  }

  const resolveAutoMode = async (sid: string, text: string): Promise<Exclude<Mode, "auto" | "bypass">> => {
    let r = classifyHeuristic(text)
    if (!r) r = await classifyModel(text)
    autoResolved.set(sid, r)
    log("engine", `auto mode → ${r} for "${text.slice(0, 40)}"`)
    return r
  }

  // In auto mode, decide each permission request by the per-task resolved sub-mode.
  // Returns whether to auto-approve; otherwise the request is forwarded to the user.
  const autoApproves = (sid: string, permName: string): boolean => {
    if (mode === "bypass") return true
    if (mode !== "auto") return false // static modes: the block already enforced — forward the rest
    const sub = autoResolved.get(sid) ?? "ask"
    if (sub === "auto-edit") return ["edit", "write", "read", "webfetch"].includes(permName)
    return false // ask / plan → forward (plan agent already blocks edits)
  }

  // --- Hollywood auto-router (stuntdouble scoring, WITHIN the active provider) -
  // Mirrors packages/opencode/src/hollywood/router.ts scoreMessage. In /model
  // auto it scores each message and casts a model OF THE ACTIVE PROVIDER ONLY:
  // cheap scenes → smaller model + lower effort, hard scenes → bigger model +
  // higher effort. It NEVER mixes providers (that's a future "mix model" mode).
  type Tier = "low" | "mid" | "high"
  const HC_HIGH =
    /\b(architect(ure)?|design\s+(a|the|an)?\s*(system|api|schema)|refactor|migrat(e|ion)|debug|race\s*condition|deadlock|concurren|optimi[sz]e|algorithm|security|vulnerab|authenticat|performance|scal(e|ing|ability)|implement|integrat(e|ion)|build\s+(a|an|the|me)|create\s+(a|an|the|me)|rewrite|overhaul)\b/i
  const HC_LOW =
    /^(hi|hey|hello|oi|ol[aá]|thanks?|thank you|valeu|obrigad[oa]|ok|sure|yes|no|nice|cool|legal|great|what( is|'s)|who( is|'s)|when|explain|summari[sz]e|translate|format|rename|list)\b/i
  const HC_QUALITY = /\b(production|prod\b|critical|public\s+api|deploy|release|customer|security|payment|sensitive)\b/i
  const HC_SPEED = /\b(quick(ly)?|fast|just|simple|simples|r[aá]pido|draft|rough|throwaway|prototype|test(ing)?\s+only)\b/i
  const HC_FILE = /[\w./\\-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|css|html|json|yml|yaml|md|sql|sh|ps1|lua|c|cpp|h)\b/gi
  const HC_CODE = /```|\n {4}\S/
  const HC_STACK = /\b(at\s+\S+\s+\(|Traceback|Error:|exception|panic:)/i
  const HC_MULTI = /\b(and|then|also|plus|e\s+depois|al[eé]m)\b/gi
  const scoreTask = (text: string): { tier: Tier; score: number } => {
    const t = text.trim()
    const len = t.length
    let complexity = 0.35
    if (HC_LOW.test(t)) complexity = 0.1
    if (HC_HIGH.test(t)) complexity = 0.75
    if (HC_CODE.test(t) || HC_STACK.test(t)) complexity = Math.max(complexity, 0.55)
    if ((t.match(HC_MULTI) ?? []).length >= 4 && len > 300) complexity = Math.min(1, complexity + 0.15)
    let context = 0.1
    if (len > 300) context = 0.3
    if (len > 1000) context = 0.6
    if (len > 4000) context = 0.9
    if ((t.match(HC_FILE) ?? []).length >= 2) context = Math.min(1, context + 0.2)
    let quality = 0.4
    if (HC_QUALITY.test(t)) quality = 0.85
    if (HC_LOW.test(t) && len < 200) quality = 0.2
    const speed = HC_SPEED.test(t) ? 0.7 : 0
    const score = Math.min(1, Math.max(0, 0.4 * complexity + 0.2 * context + 0.25 * quality - 0.15 * speed))
    const tier: Tier = score <= 0.33 ? "low" : score <= 0.66 ? "mid" : "high"
    return { tier, score }
  }

  // Per-provider casting table: smaller → bigger model by tier. Validated live
  // against the provider's actual models; unavailable names are skipped. This is
  // only the SAFETY FALLBACK — candidatesFor() below discovers new models
  // dynamically from the provider's live list, so the router adapts on its own
  // when a provider ships a new generation (no more being stuck on old models).
  const TIER_MODELS: Record<string, Record<Tier, string[]>> = {
    openai: {
      low: ["gpt-5.6-luna", "gpt-5.6", "gpt-5.4-mini"],
      mid: ["gpt-5.6-terra", "gpt-5.6", "gpt-5.4"],
      high: ["gpt-5.6-sol", "gpt-5.6-pro", "gpt-5.6", "gpt-5.5"],
    },
    anthropic: {
      low: ["claude-haiku-4-5", "claude-3-5-haiku"],
      mid: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"],
      high: ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-5"],
    },
    google: {
      low: ["gemini-3-flash", "gemini-2.5-flash"],
      mid: ["gemini-3-pro", "gemini-2.5-pro"],
      high: ["gemini-3-ultra", "gemini-ultra"],
    },
    opencode: {
      low: ["claude-haiku-4-5", "deepseek-v4-flash-free", "big-pickle"],
      mid: ["big-pickle", "qwen3-coder", "claude-sonnet-4-6"],
      high: ["claude-fable-5", "claude-opus-4-8", "big-pickle"],
    },
  }
  // Newest-first version ordering: "5.6" > "5.4" > "5".
  const compareModelVersions = (a: string, b: string): number => {
    const left = a.split(".").map(Number)
    const right = b.split(".").map(Number)
    const size = Math.max(left.length, right.length)
    for (let i = 0; i < size; i++) {
      const delta = (right[i] ?? 0) - (left[i] ?? 0)
      if (delta) return delta
    }
    return 0
  }
  // DYNAMIC tier discovery — one parser per provider family. Maps a live model
  // id → {tier, version, penalty}; penalty pushes variant builds (-fast/-pro,
  // date-stamped ids…) behind the canonical one of the same version.
  const DYNAMIC_FAMILIES: Record<
    string,
    (id: string) => { tier: Tier; version: string; penalty: number } | undefined
  > = {
    // OpenAI's gpt-5.6 generation renamed the tiers: luna (small) / terra (mid)
    // / sol (frontier), with optional -fast/-pro builds.
    openai: (id) => {
      const m = /^gpt-(\d+(?:\.\d+)*?)-(luna|terra|sol)(?:-(fast|pro))?$/.exec(id)
      if (!m) return undefined
      const tier: Tier = m[2] === "luna" ? "low" : m[2] === "terra" ? "mid" : "high"
      return { tier, version: m[1]!, penalty: m[3] ? 1 : 0 }
    },
    // Anthropic: family name IS the tier (haiku/sonnet/opus + fable at the top).
    anthropic: (id) => {
      const m = /^claude-(fable|opus|sonnet|haiku)-(\d+(?:[.-]\d+)*)$/.exec(id)
      if (!m) return undefined
      const tier: Tier = m[1] === "haiku" ? "low" : m[1] === "sonnet" ? "mid" : "high"
      const nums = m[2]!.split(/[.-]/)
      const major = Number(nums[0] ?? 0) + (m[1] === "fable" ? 100 : 0) // fable outranks opus
      return { tier, version: [String(major), ...nums.slice(1)].join("."), penalty: 0 }
    },
    // Google: flash-lite (small) / flash (mid) / pro+ultra (frontier).
    google: (id) => {
      const m = /^gemini-(\d+(?:\.\d+)*)-(flash-lite|flash|pro|ultra)$/.exec(id)
      if (!m) return undefined
      const tier: Tier = m[2] === "flash-lite" ? "low" : m[2] === "flash" ? "mid" : "high"
      return { tier, version: m[1]!, penalty: m[2] === "pro" ? 1 : 0 } // ultra beats pro
    },
  }
  const candidatesFor = (providerID: string, tier: Tier, available: string[]): string[] => {
    const fallback = TIER_MODELS[providerID]?.[tier] ?? []
    const parse = DYNAMIC_FAMILIES[providerID]
    if (!parse) return fallback
    const discovered = available
      .flatMap((id) => {
        const d = parse(id)
        return d && d.tier === tier ? [{ id, version: d.version, penalty: d.penalty }] : []
      })
      .sort((a, b) => compareModelVersions(a.version, b.version) || a.penalty - b.penalty)
      .map((x) => x.id)
    return [...new Set([...discovered, ...fallback])]
  }
  // Pick a reasoning-effort variant matching the tier from the model's available ones.
  const pickEffort = (keys: string[], tier: Tier): string | undefined => {
    if (!keys.length) return undefined
    const pref =
      tier === "low" ? ["low", "minimal", "none"] : tier === "mid" ? ["medium", "low", "high"] : ["xhigh", "high", "max", "medium"]
    for (const p of pref) if (keys.includes(p)) return p
    return tier === "high" ? keys[keys.length - 1] : keys[0]
  }
  // Cast a model + effort for the task, WITHIN the active provider only.
  const castForAuto = async (
    text: string,
  ): Promise<{ model?: { providerID: string; modelID: string }; variant?: string; tier: Tier; score: number }> => {
    const { tier, score } = scoreTask(text)
    const providerID = config.autoProvider || freeModel?.providerID || "opencode"
    try {
      const prov = await opencode.client.config.providers()
      const providers: any[] = (prov.data as any)?.providers ?? []
      const p = providers.find((x: any) => x.id === providerID)
      if (p?.models) {
        const cands = candidatesFor(providerID, tier, Object.keys(p.models))
        for (const c of cands) {
          if (p.models[c]) {
            const variant = pickEffort(Object.keys(p.models[c]?.variants ?? {}), tier)
            return { model: { providerID, modelID: c }, variant, tier, score }
          }
        }
        // No tier candidate available → stay IN-PROVIDER with its first model.
        const first = Object.keys(p.models)[0]
        if (first) {
          const variant = pickEffort(Object.keys(p.models[first]?.variants ?? {}), tier)
          return { model: { providerID, modelID: first }, variant, tier, score }
        }
      }
    } catch { /* ignore */ }
    return { model: freeModel, tier, score } // provider unavailable → free, no mixing
  }

  // Director duo — the orchestration cast: the DIRECTOR/STAR is the BEST model
  // of the active provider, the STUNT DOUBLE is the SECOND-BEST. Used by the
  // director-cut pipeline on high-tier tasks in auto mode.
  const castDuo = async (): Promise<
    | {
        best: { providerID: string; modelID: string }
        second?: { providerID: string; modelID: string }
        bestVariant?: string
        secondVariant?: string
      }
    | undefined
  > => {
    const providerID = config.autoProvider || freeModel?.providerID || "opencode"
    try {
      const prov = await opencode.client.config.providers()
      const providers: any[] = (prov.data as any)?.providers ?? []
      const p = providers.find((x: any) => x.id === providerID)
      const tiers = TIER_MODELS[providerID]
      if (!p?.models || !tiers) return undefined
      const avail = (names: string[]) => names.filter((n) => p.models[n])
      const available = Object.keys(p.models)
      const high = avail(candidatesFor(providerID, "high", available))
      const best = high[0]
      if (!best) return undefined
      const second =
        high.find((n) => n !== best) ?? avail(candidatesFor(providerID, "mid", available)).find((n) => n !== best)
      const variantsOf = (m: string) => Object.keys(p.models[m]?.variants ?? {})
      return {
        best: { providerID, modelID: best },
        second: second ? { providerID, modelID: second } : undefined,
        bestVariant: pickEffort(variantsOf(best), "high"),
        secondVariant: second ? pickEffort(variantsOf(second), "mid") : undefined,
      }
    } catch {
      return undefined
    }
  }

  // --- Mix model (CROSS-provider) — separate, only when config.model === "mix" -
  // Casts ACROSS providers by tier from config.mixTable (auto-detected when a
  // tier is unset): low → free double, high → best paid model of any provider.
  // Kept fully separate from castForAuto so the per-provider router is untouched.
  const parseRef = (s?: string): { providerID: string; modelID: string } | undefined => {
    if (!s || !s.includes("/")) return undefined
    const i = s.indexOf("/")
    return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
  }
  const castForMix = async (
    text: string,
  ): Promise<{ model?: { providerID: string; modelID: string }; variant?: string; tier: Tier; score: number }> => {
    const { tier, score } = scoreTask(text)
    let providers: any[] = []
    try {
      const prov = await opencode.client.config.providers()
      providers = (prov.data as any)?.providers ?? []
    } catch { /* ignore */ }
    const modelOf = (providerID: string, modelID: string) => providers.find((p: any) => p.id === providerID)?.models?.[modelID]
    const variantOf = (providerID: string, modelID: string) => pickEffort(Object.keys(modelOf(providerID, modelID)?.variants ?? {}), tier)
    // 1. explicit mixTable entry for this tier (if it still exists)
    const explicit = parseRef(config.mixTable?.[tier])
    if (explicit && modelOf(explicit.providerID, explicit.modelID)) {
      return { model: explicit, variant: variantOf(explicit.providerID, explicit.modelID), tier, score }
    }
    // 2. auto-detect: low → free double; mid/high → best paid model across providers
    if (tier === "low") {
      const v = freeModel ? variantOf(freeModel.providerID, freeModel.modelID) : undefined
      return { model: freeModel, variant: v, tier, score }
    }
    const order = [...providers.filter((p: any) => p.id !== "opencode"), ...providers.filter((p: any) => p.id === "opencode")]
    for (const p of order) {
      for (const c of candidatesFor(p.id, tier, Object.keys(p.models ?? {}))) {
        if (p.models?.[c]) return { model: { providerID: p.id, modelID: c }, variant: variantOf(p.id, c), tier, score }
      }
    }
    return { model: freeModel, tier, score } // nothing better → free fallback
  }

  // ---------------------------------------------------------------------------
  // promptWithFallback — run a prompt and, if the selected model fails (request
  // error or a provider error part like "insufficient credits"), retry once on
  // the free model (the host default, e.g. opencode/big-pickle). A paid-provider
  // failure should degrade to the free model, never dead-end the bot.
  // ---------------------------------------------------------------------------
  const replyTextOf = (r: any): string =>
    (((r?.data?.parts ?? []) as any[])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text || "")
      .join("\n")
      .trim()) || ""
  const promptFailed = (r: any): boolean => {
    if (r?.error || !r?.data) return true
    // No assistant text = failure. A paid model with no credits returns an EMPTY
    // response (no parts, no error part) — so checking only for error parts let it
    // slip through as "success" and the bot replied with nothing (looked frozen).
    // Falling back is gated on a pinned paid model below, so a free model's empty
    // turn never pointlessly re-runs.
    return !replyTextOf(r)
  }
  // Pull the provider error text out of a failed result (request error OR a
  // retry/error part the server attached to the turn).
  const errorTextOf = (r: any): string => {
    const parts: any[] = (r?.data?.parts ?? []) as any[]
    const fromParts = parts
      .filter((p) => p?.type === "retry" || p?.type === "error")
      .map((p) => p?.error?.data?.message || p?.error?.message || (typeof p?.error === "string" ? p.error : ""))
      .join(" ")
    const fromErr =
      r?.error?.data?.message || r?.error?.message || (typeof r?.error === "string" ? r.error : "")
    return `${fromErr} ${fromParts}`.trim()
  }
  // Hard provider limits that a retry won't fix (out of quota/credits, plan caps,
  // rate limits, bad auth). Used to message the user precisely.
  const isHardLimit = (text: string): boolean =>
    /usage limit|limit (reached|exceeded)|quota|insufficient|exceeded|rate.?limit|too many requests|\b40[13]\b|\b402\b|\b429\b|payment required|unauthor|invalid api key|no credit|out of credit|credit balance|balance too low|billing/i.test(
      text || "",
    )
  // A pinned model that keeps failing (quota/credits/rate-limit/timeout) must not
  // cost 45s on EVERY message. After 2 consecutive failures, mark it "dead" for a
  // cooldown: skip it and fall back immediately. Reset on any success.
  const modelFails = new Map<string, number>()
  const modelDeadUntil = new Map<string, number>()
  const DEAD_COOLDOWN_MS = 5 * 60_000
  const mkey = (m: { providerID: string; modelID: string }) => `${m.providerID}/${m.modelID}`
  const noteModelSuccess = (m?: { providerID: string; modelID: string }) => {
    if (!m) return
    modelFails.delete(mkey(m))
    modelDeadUntil.delete(mkey(m))
  }
  const noteModelFailure = (m?: { providerID: string; modelID: string }) => {
    if (!m) return
    const k = mkey(m)
    const n = (modelFails.get(k) ?? 0) + 1
    modelFails.set(k, n)
    if (n >= 2) modelDeadUntil.set(k, Date.now() + DEAD_COOLDOWN_MS)
  }
  const isModelDead = (m?: { providerID: string; modelID: string }) =>
    !!m && (modelDeadUntil.get(mkey(m)) ?? 0) > Date.now()
  // Turn a raw provider error into a clear, actionable message for the user.
  const hardErrorNotice = (model: string, err: string): string => {
    const low = (err || "").toLowerCase()
    // Many providers (incl. opencode zen) put the reset window in the error text
    // ("...will reset in 2 hours" / "resets at 1:54 PM") — surface it if present.
    const resetM = (err || "").match(/reset[s]?\b[^.\n]*?\b(in\s+[\w.\s]+?(?:second|minute|hour|day)s?|at\s+[\d:apm.\s]+)/i)
    const reset = resetM ? ` — resets ${resetM[1].trim()}` : ""
    if (/usage limit|plan|quota/.test(low))
      return `⚠️ *${model}* hit its usage limit (plans like ChatGPT Plus cap the top models)${reset}. Switch with /model — e.g. \`gpt-5.6-luna\` — or wait for the reset.`
    if (/rate.?limit|too many|429/.test(low))
      return `⚠️ *${model}* is rate-limited right now. Try again shortly, or switch with /model.`
    if (/401|403|unauthor|api key|invalid|credit|billing|insufficient/.test(low))
      return `⚠️ *${model}*: auth or credits problem. Re-connect the provider or add credits, or switch with /model.`
    return `⚠️ *${model}* failed: ${(err || "unknown error").slice(0, 160)}\nSwitch with /model or start fresh with /new.`
  }
  const promptWithFallback = async (
    sessionId: string,
    parts: any[],
    model: { providerID: string; modelID: string } | undefined,
    variantOverride?: string,
    opts?: {
      // Only the AUTO/MIX router may substitute models. When the user PINNED a
      // model, it must be THE model that answers — on trouble we inform, never
      // impersonate with the free fallback.
      allowFallback?: boolean
    },
  ): Promise<{ result: any; fellBackTo?: string; hardError?: string; skippedDead?: boolean }> => {
    const allowFallback = opts?.allowFallback ?? true
    const run = (m?: { providerID: string; modelID: string }) => {
      const body: any = { parts, agent: agentForMode(sessionId) }
      if (m) body.model = m
      // Reasoning effort = model variant, a per-prompt field. variantOverride wins
      // (auto-router casts effort per task); else the pinned /effort. Free fallback
      // (no model) carries no variant.
      const variant = variantOverride ?? config.effort
      if (variant && m) body.variant = variant
      return opencode.client.session
        .prompt({ path: { id: sessionId }, body })
        .catch((err: any) => ({ error: err, data: undefined }))
    }
    const fb = freeModel
    const isPinnedPaid =
      !!model && (!fb || model.providerID !== fb.providerID || model.modelID !== fb.modelID)

    // The routed model failed repeatedly very recently (quota/credits/rate-limit/
    // timeout) → don't burn the timeout on it again. Go straight to the free
    // fallback and tell the caller we skipped a dead model. AUTO/MIX only — a
    // user-pinned model is always honored and retried.
    if (model && isPinnedPaid && allowFallback && isModelDead(model)) {
      log("engine", `skipping recently-dead ${mkey(model)} — falling back directly`)
      if (fb) {
        const retry = await run(fb)
        if (!promptFailed(retry)) return { result: retry, fellBackTo: `${fb.providerID}/${fb.modelID}`, skippedDead: true }
        return { result: retry, skippedDead: true, hardError: errorTextOf(retry) || undefined }
      }
    }

    // Abort policy (user spec): while the agent is WORKING it is never
    // interrupted and never spammed with "still waiting" notices. A running tool
    // emits no events (a 5-minute bash is silent), so silence ≠ stuck — a tool in
    // flight counts as activity. The ONLY early abort is a detected hard provider
    // limit (credits/quota/rate, stamped live from "retry" parts by the event
    // stream); only that may engage the fallback. A generous silent window plus
    // an absolute ceiling catch true zombies with a clear error — no substitution.
    // Work in flight is NEVER cancelled (user spec: don't abort, don't go quiet,
    // don't waste money on a cancelled long patch). While the parent or ANY
    // subagent has a tool running, the turn is alive no matter how long the model
    // takes between events — a big apply_patch streams for minutes in silence.
    // Only two things end a turn early: a hard provider limit (credits/quota), or
    // a truly dead session (no events, no tools anywhere) past a long window.
    const SILENT_MS = 12 * 60_000 // nothing at all happening for 12min → zombie
    const HARD_CEIL_MS = 6 * 60 * 60_000 // safety ceiling only (never hit in practice)
    const BEAT_MS = 25_000 // heartbeat so the status never looks frozen
    const runFirst = async () => {
      if (!isPinnedPaid) return run(model)
      const started = Date.now()
      lastActivity.set(sessionId, started) // reset so an old stamp can't insta-abort
      hardLimitHit.delete(sessionId) // stale stamps from a previous turn don't count
      lastStreamError.delete(sessionId)
      const TIMEOUT = Symbol("timeout")
      const HARDSTOP = Symbol("hardstop")
      let timer: ReturnType<typeof setInterval> | undefined
      let lastBeat = Date.now()
      const stallWatch = new Promise<typeof TIMEOUT | typeof HARDSTOP>((res) => {
        timer = setInterval(() => {
          const now = Date.now()
          if (hardLimitHit.has(sessionId)) return res(HARDSTOP)
          // A tool in flight IS work — in the parent OR in any subagent.
          const working = hasActiveWork(sessionId)
          if (working) lastActivity.set(sessionId, now)
          // Heartbeat: refresh the status with the elapsed time so the user can
          // SEE it is still working during long silent stretches (big patches,
          // deep reasoning) instead of staring at a frozen "working".
          if (statusHandles.has(sessionId) && now - lastBeat > BEAT_MS) {
            lastBeat = now
            const quiet = Math.round((now - (lastActivity.get(sessionId) ?? started)) / 1000)
            const note = working
              ? `⏱ still working — ${fmtElapsed(now - started)} elapsed`
              : `⏱ still working — ${fmtElapsed(now - started)} elapsed · model thinking/writing for ${quiet}s`
            pushStatusEdit(sessionId, renderStatus(sessionId, note))
          }
          const idle = now - (lastActivity.get(sessionId) ?? started)
          if (now - started > HARD_CEIL_MS) return res(TIMEOUT)
          if (!working && idle > SILENT_MS) res(TIMEOUT)
        }, 5000)
      })
      const raced = await Promise.race([run(model), stallWatch])
      if (timer) clearInterval(timer)
      if (raced === HARDSTOP) {
        const why = hardLimitHit.get(sessionId) || "provider limit reached"
        log("engine", `model ${mkey(model!)} hit a hard provider limit — aborting (${why.slice(0, 140)})`)
        await opencode.client.session.abort({ path: { id: sessionId } }).catch(() => {})
        return { error: new Error(why), data: undefined }
      }
      if (raced === TIMEOUT) {
        // Name the REAL cause when we saw one in the stream (a quota error the
        // SDK kept retrying looks like silence otherwise) — the user gets
        // "usage limit" instead of a mysterious "went silent".
        const seen = lastStreamError.get(sessionId)
        log("engine", `model ${mkey(model!)} produced no output and ran no tools — giving up after ${Math.round((Date.now() - started) / 1000)}s${seen ? ` (last error: ${seen.slice(0, 120)})` : ""}`)
        await opencode.client.session.abort({ path: { id: sessionId } }).catch(() => {})
        return {
          error: new Error(seen || `model produced no output (waited ${Math.round((Date.now() - started) / 1000)}s)`),
          data: undefined,
        }
      }
      return raced
    }

    const result = await runFirst()
    if (!promptFailed(result)) {
      noteModelSuccess(model)
      hardLimitHit.delete(sessionId)
      return { result }
    }
    const pinnedErr = errorTextOf(result) || (result as any)?.error?.message || ""
    const hadHardLimit = isHardLimit(pinnedErr) || hardLimitHit.has(sessionId)
    hardLimitHit.delete(sessionId)
    // Dead-marking only on hard limits (persistent conditions worth skipping); a
    // one-off silent turn must not poison the model for the next messages.
    if (hadHardLimit) noteModelFailure(model)
    // Fallback policy (user spec): ONLY a hard provider limit (credits/quota/
    // rate) engages the free fallback, and only for the AUTO/MIX router. Every
    // other failure surfaces the real error — a weak model must never quietly
    // answer a heavy task in the pinned model's place.
    if (!fb || !isPinnedPaid || !allowFallback || !hadHardLimit)
      return { result, hardError: pinnedErr || undefined }
    log("engine", `hard limit on ${model ? mkey(model) : "?"} — falling back to ${fb.providerID}/${fb.modelID}`)
    const retry = await run(fb)
    if (!promptFailed(retry)) return { result: retry, fellBackTo: `${fb.providerID}/${fb.modelID}` }
    // Both failed → surface the most informative hard error so the user knows why.
    const fbErr = errorTextOf(retry)
    const hard = isHardLimit(pinnedErr) ? pinnedErr : isHardLimit(fbErr) ? fbErr : pinnedErr || fbErr
    return { result, hardError: hard || undefined }
  }

  // Whether a model can SEE images (vision). Read from config.providers()
  // capabilities.input.image, cached per model.
  const visionCache = new Map<string, boolean>()
  const modelCanSeeImages = async (providerID?: string, modelID?: string): Promise<boolean> => {
    if (!providerID || !modelID) return false
    const key = `${providerID}/${modelID}`
    if (visionCache.has(key)) return visionCache.get(key)!
    let can = false
    try {
      const prov = await opencode.client.config.providers()
      const providers: any[] = (prov.data as any)?.providers ?? []
      const p = providers.find((x: any) => x.id === providerID)
      const m = p?.models?.[modelID]
      can = !!(m?.capabilities?.input?.image ?? m?.attachment ?? false)
    } catch { /* unknown → assume no vision */ }
    visionCache.set(key, can)
    return can
  }

  // Video understanding = sample a few frames with ffmpeg and send them to a
  // vision model as images (LLMs can't watch raw video; frames are the trick).
  const resolveFfmpeg = (): string | undefined => {
    const fromEnv = (process.env.HOLLYCODE_FFMPEG || "").trim()
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
    const bundled = path.join(os.homedir(), ".hollycode", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
    if (fs.existsSync(bundled)) return bundled
    return "ffmpeg" // hope it's on PATH; runFfmpeg() surfaces ENOENT if not
  }
  const runFfmpeg = (bin: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      let p: ChildProcess
      try {
        p = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"] })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      p.on("error", reject)
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
    })
  // Extract up to `count` frames as image data URLs. Returns [] (and logs) if
  // ffmpeg is missing or fails, so the caller can warn the user.
  const extractVideoFrames = async (videoPath: string, count = 4): Promise<string[]> => {
    const bin = resolveFfmpeg()
    if (!bin) return []
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "holly-vid-"))
    try {
      await runFfmpeg(bin, ["-y", "-i", videoPath, "-vf", "fps=1,scale=512:-1", "-frames:v", String(count), path.join(dir, "f_%03d.png")])
      const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")).sort().slice(0, count)
      return files.map((f) => `data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString("base64")}`)
    } catch (e: any) {
      log("engine", `ffmpeg frame extraction failed: ${e?.message ?? e}`)
      return []
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // handleMessage
  // ---------------------------------------------------------------------------

  const handleMessageInner = async (
    channelId: string,
    msg: {
      conversationId: string
      userId: string
      text: string
      images?: Array<{ url: string; mime: string; filename?: string }>
      videos?: Array<{ path: string; filename?: string; temporary?: boolean }>
      attachments?: Array<{ path: string; filename: string; mime?: string; size?: number }>
    },
    responder: Responder,
  ) => {
    const sessionId = await getOrCreateSession(channelId, msg.conversationId)
    if (!sessionId) {
      await responder.sendText("Sorry, I couldn't create a session. Try /new.")
      return
    }

    // Remember this conversation's responder so the global reconciler can
    // deliver late permission/question prompts even after prompt() returns.
    activeResponders.set(sessionId, responder)

    await responder.typing().catch(() => {})
    const statusHandle = await responder.startStatus("🎬 working...")
    statusHandles.set(sessionId, statusHandle)
    statusLines.set(sessionId, [])
    turnStarted.set(sessionId, Date.now()) // elapsed time for the live report
    turnFiles.delete(sessionId) // files are reported per turn
    turnRequest.set(sessionId, (msg.text || "(media/attachment)").slice(0, 600)) // side-chat context

    await resolvePending(sessionId, responder)

    // Auto mode: classify THIS task into a concrete sub-mode before prompting,
    // so the right agent (plan vs build) and approval policy apply to this turn.
    if (mode === "auto") {
      const sub = await resolveAutoMode(sessionId, msg.text)
      await responder
        .sendText(
          sub === "plan"
            ? "🤖 auto → 📋 plan (read-only for this task)"
            : sub === "auto-edit"
              ? "🤖 auto → ✍️ auto-edit (applying changes for this task)"
              : "🤖 auto → 🙋 ask (I'll confirm risky steps)",
        )
        .catch(() => {})
    }

    const flavor = PERSONALITIES[personality]
    const goal = goalMap.get(sessionKey(channelId, msg.conversationId))
    // Routing: one selector (config.model), 3 mutually-exclusive modes.
    //   "auto" → per-provider router (within autoProvider)
    //   "mix"  → cross-provider router (across providers, via mixTable)
    //   else   → pinned model (fixed)
    // auto and mix never run together — sibling branches below.
    let pinnedModel = config.model && config.model !== "auto" && config.model !== "mix" ? defaultModel : undefined
    let autoTier: Tier | undefined
    let autoVariant: string | undefined
    let routeKind: "auto" | "mix" | undefined
    if (config.model === "auto") {
      // DIRECTOR-FIRST auto mode (user spec): the provider's STRONGEST model at
      // HIGH effort always fronts the Telegram conversation. The task score no
      // longer decides WHO answers — it only decides whether the director
      // delegates the heavy lifting to the stunt double (the director-cut
      // pipeline below) or just does the task himself. Either way the DIRECTOR
      // delivers the final reply.
      routeKind = "auto"
      autoTier = scoreTask(msg.text).tier
      const duo = await castDuo()
      if (duo) {
        pinnedModel = duo.best
        autoVariant = duo.bestVariant
      } else {
        // Provider without a casting table — fall back to the old per-tier cast.
        const cast = await castForAuto(msg.text)
        pinnedModel = cast.model
        autoVariant = cast.variant
      }
    } else if (config.model === "mix") {
      const cast = await castForMix(msg.text)
      pinnedModel = cast.model
      autoTier = cast.tier
      autoVariant = cast.variant
      routeKind = "mix"
    }

    // Gather visual media as images: direct images + frames sampled from videos.
    const mediaImages: Array<{ url: string; mime: string; filename?: string }> = [...(msg.images ?? [])]
    if (msg.videos?.length) {
      for (const v of msg.videos) {
        const frames = await extractVideoFrames(v.path)
        // Persisted attachments (temporary: false) stay on disk for the agent.
        if (v.temporary !== false) {
          try { fs.rmSync(v.path, { force: true }) } catch { /* temp cleanup */ }
        }
        if (frames.length) {
          frames.forEach((url, i) =>
            mediaImages.push({ url, mime: "image/png", filename: `${v.filename ?? "video"}-frame${i + 1}.png` }),
          )
        } else {
          await responder
            .sendText(
              "🎥 I couldn't read that video — frame extraction needs ffmpeg, which isn't installed. " +
                "Install ffmpeg (or set HOLLYCODE_FFMPEG) and resend, or send a screenshot of the moment you care about.",
            )
            .catch(() => {})
        }
      }
    }

    let baseText = msg.text
    if (!baseText && mediaImages.length) baseText = "(media attached — look at it and respond)"
    // Attachments live on disk — give the agent the absolute paths so it can
    // copy/move/convert the actual files, not just read them in chat.
    if (msg.attachments?.length) {
      const paths = msg.attachments
        .map((file) => `- ${file.filename}: ${file.path}${file.mime ? ` (${file.mime})` : ""}`)
        .join("\n")
      baseText = `${baseText || "(file attached — ask what the user wants done with it)"}\n\n[Local attachment paths]\n${paths}`
    }
    let promptText = flavor ? `[Personality: ${flavor}]\n\n${baseText}` : baseText
    if (goal) promptText = `[Goal: ${goal} — keep working until this is fully met; do not stop early.]\n\n${promptText}`
    // Voice conversation: the reply will be SPOKEN (TTS), so ask the model for
    // speakable prose at the source — no markdown, no lists, no code blocks, no
    // symbols — instead of only sanitizing them out afterwards.
    if ((msg as any).audio) {
      promptText =
        `[Voice conversation: your reply will be read aloud by text-to-speech. Answer in natural spoken prose, in the user's language. ` +
        `Keep it concise and conversational. Do NOT use markdown, asterisks, bullet lists, headings, tables, code blocks, URLs or emojis — ` +
        `say numbers and percentages in words when natural.]\n\n${promptText}`
    }

    // Selective long-term memory (ChatGPT-Memories style): the archive lives
    // OUT of the context; inject only the few facts relevant to THIS message.
    // Usage bumps feed the curator, so recalled facts stay fresh.
    if (baseText.length >= 6) {
      try {
        const hits = memory.search([DIRECTORY, MEM_SCOPE_USER], baseText, 5)
        if (hits.length) {
          memory.touch(hits.map((h) => h.id))
          promptText = `[Relevant memories]\n${hits.map((h) => `- ${h.text}`).join("\n")}\n\n${promptText}`
        }
      } catch {
        /* retrieval is best-effort */
      }
    }

    // Build prompt parts; attach media when the active model has vision. Both
    // pinned and auto resolve to a concrete model here, so the check is precise.
    const promptParts: any[] = [{ type: "text", text: promptText }]
    if (mediaImages.length) {
      const canSee = pinnedModel ? await modelCanSeeImages(pinnedModel.providerID, pinnedModel.modelID) : true
      if (canSee) {
        for (const img of mediaImages) promptParts.push({ type: "file", mime: img.mime, filename: img.filename, url: img.url })
      } else {
        await responder
          .sendText(
            `👁️ ${pinnedModel!.providerID}/${pinnedModel!.modelID} can't see images/video. Switch to a vision model with /model, then resend.`,
          )
          .catch(() => {})
      }
    }

    if (verbose) log("engine", `handleMessage: goal=${goal ?? "none"} flavor=${personality} media=${mediaImages.length}`)
    log("engine", `handleMessage: "${msg.text.slice(0, 40)}" model=${pinnedModel ? `${pinnedModel.providerID}/${pinnedModel.modelID}` : "auto"} images=${msg.images?.length ?? 0} → prompting...`)

    const poller = setInterval(() => { void resolvePending(sessionId, responder) }, 3000)
    // Substitution policy: only the AUTO/MIX router may swap models. A model the
    // user pinned via /model is THE model — never impersonated by the fallback.
    const isRouted = routeKind !== undefined
    // No progress chatter while the agent works (user spec): the live status
    // message already shows the tools in flight; extra "still waiting" texts are
    // noise. The only mid-turn message allowed is a detected hard provider limit,
    // which promptWithFallback surfaces via hardError/fellBackTo.
    const promptOpts = { allowFallback: isRouted || !pinnedModel }

    let result: any
    let fellBackTo: string | undefined
    let hardError: string | undefined
    let skippedDead: boolean | undefined
    let directorCut = false

    // 🎬 DIRECTOR-CUT pipeline (auto mode, high-tier tasks): the DIRECTOR (best
    // model of the provider) plans → the STUNT DOUBLE (second-best) executes →
    // the STAR (best) verifies and fixes → the DIRECTOR returns for the final
    // cut: reviews everything, checks quality, validates and delivers the final
    // answer. All passes share the same session, so each sees the previous work.
    if (routeKind === "auto" && autoTier === "high") {
      const duo = await castDuo()
      if (duo?.second) {
        const dbl = duo.second
        directorCut = true
        log("engine", `director-cut: director/star=${duo.best.modelID} double=${dbl.modelID}`)
        const passes = [
          {
            label: `🎬 Director planning (${duo.best.modelID})…`,
            model: duo.best,
            variant: duo.bestVariant,
            text:
              `${promptText}\n\n[🎬 DIRECTOR — PLANNING PASS] You are the director (the strongest model). ` +
              `Produce a concise, concrete plan for the request above: steps, files/areas to touch, risks. Do NOT execute anything yet.`,
          },
          {
            label: `🤸 Stunt double working (${dbl.modelID})…`,
            model: dbl,
            variant: duo.secondVariant,
            text:
              `[🤸 STUNT DOUBLE — EXECUTION PASS] Execute the director's plan above COMPLETELY. ` +
              `Do the real work now (use tools as needed) and report what you did.`,
          },
          {
            label: `⭐ Star verifying (${duo.best.modelID})…`,
            model: duo.best,
            variant: duo.bestVariant,
            text:
              `[⭐ STAR — VERIFICATION PASS] Verify everything the stunt double did against the original request. ` +
              `Find any problems and FIX them yourself now. Briefly report what you checked and fixed.`,
          },
          {
            label: `🎬 Director final cut (${duo.best.modelID})…`,
            model: duo.best,
            variant: duo.bestVariant,
            text:
              `[🎬 DIRECTOR — FINAL CUT] Review ALL the work done for this request: completeness, code quality, correctness. ` +
              `Finish anything missing, then give the FINAL consolidated answer for the user, in the user's language.`,
          },
        ]
        for (let i = 0; i < passes.length; i++) {
          const p = passes[i]!
          await statusHandle.update(`🎬 working...\n${p.label}`).catch(() => {})
          // Pass 1 carries the original attachments (images/frames); later passes
          // continue in-session and don't need them re-sent.
          const parts = i === 0 ? [{ type: "text", text: p.text }, ...promptParts.slice(1)] : [{ type: "text", text: p.text }]
          const r = await promptWithFallback(sessionId, parts, p.model, p.variant, promptOpts)
          if (r.fellBackTo) fellBackTo = r.fellBackTo
          if (promptFailed(r.result)) {
            hardError = r.hardError
            result = result ?? r.result // keep the last good pass as the reply
            log("engine", `director-cut: pass ${i + 1} failed — stopping the pipeline here`)
            break
          }
          result = r.result
        }
      }
    }

    if (result === undefined) {
      const single = await promptWithFallback(sessionId, promptParts, pinnedModel, autoVariant, promptOpts)
      result = single.result
      fellBackTo = single.fellBackTo
      hardError = single.hardError
      skippedDead = single.skippedDead
    }
    clearInterval(poller)
    log("engine", `handleMessage: prompt returned (fellBackTo=${fellBackTo ?? "no"}, hasData=${!!result.data}, err=${!!(result as any).error})`)
    await resolvePending(sessionId, responder)

    statusHandles.delete(sessionId)
    statusLines.delete(sessionId)
    statusRunning.delete(sessionId)
    clearStatusEdit(sessionId)
    // Slow-leak hygiene: these grow per turn/session and were never pruned.
    lastActivity.delete(sessionId)
    autoResolved.delete(sessionId)
    hardLimitHit.delete(sessionId)
    lastStreamError.delete(sessionId)
    // Flush any pending file-feed batch before the responder goes away, so the
    // last files written are still reported.
    const feed = fileFeed.get(sessionId)
    if (feed?.pending.size) {
      const rows = [...feed.pending.entries()].slice(0, 20).map(([p, t]) => {
        const v = FILE_VERB[t] ?? FILE_VERB.edit!
        return `${v.icon} ${v.verb}: ${p}`
      })
      await responder.sendText(rows.join("\n")).catch(() => {})
    }
    if (feed?.timer) clearTimeout(feed.timer)
    fileFeed.delete(sessionId)
    turnStarted.delete(sessionId)
    turnRequest.delete(sessionId)
    for (const [child, parent] of childToParent) {
      if (parent === sessionId) {
        statusRunning.delete(child) // subagent slots are per real session now
        childToParent.delete(child)
        childModelAnnounced.delete(child)
        childModel.delete(child)
      }
    }

    if ((result as any).error || !result.data) {
      console.error("Prompt failed:", (result as any).error, hardError ?? "")
      await statusHandle.finalize("⚠️ error").catch(() => {})
      const pin = pinnedModel ? `${pinnedModel.providerID}/${pinnedModel.modelID}` : "the model"
      await responder.sendText(hardError ? hardErrorNotice(pin, hardError) : "⚠️ Something went wrong. Try again or /new.")
      return
    }

    const data = result.data as any
    const info = data.info as { modelID?: string; providerID?: string; variant?: string } | undefined
    const parts = data.parts as Array<{ type: string; text?: string }> | undefined

    const reply =
      parts
        ?.filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
        .trim() || ""

    // Show the reasoning effort (variant) actually used, read from the server's
    // record of the turn — so the label reflects what ran, not just what we asked.
    const effortSuffix = info?.variant && info.variant !== "default" ? ` · ${info.variant}` : ""
    const tierSuffix = autoTier ? ` · ${routeKind}:${autoTier}` : ""
    const cutSuffix = directorCut ? " · 🎬 director-cut" : ""
    const modelLabel = info?.modelID ? `🎬 ${info.providerID}/${info.modelID}${effortSuffix}${tierSuffix}${cutSuffix}` : "🎬 done"

    if (reply) {
      await statusHandle.finalize(modelLabel).catch(() => {})
      if (fellBackTo) {
        const pin = pinnedModel ? `${pinnedModel.providerID}/${pinnedModel.modelID}` : "your model"
        await responder
          .sendText(
            `⚠️ ${pin} hit a hard usage/credit limit, so this answer came from the free ${fellBackTo}. ` +
              `When the limit resets (or after adding credits) just resend — or switch with /model.`,
          )
          .catch(() => {})
      }
      // Voice conversation: when the USER spoke, the reply is voice-ONLY (no text
      // wall after a voice note) — text is only the fallback if TTS fails. With
      // /voice on (speakAlways) for typed messages, keep text + voice (read-along).
      const voiceCapable = !!speaker && !!responder.sendVoice
      let voiceOnlyDelivered = false
      if ((msg as any).audio && voiceCapable) {
        try {
          const audio = await speaker!.synthesize(reply)
          await responder.sendVoice!(audio)
          voiceOnlyDelivered = true
        } catch (err: any) {
          log("voice", `TTS reply failed (falling back to text): ${err?.message ?? err}`)
        }
      }
      if (!voiceOnlyDelivered) {
        await responder.sendText(reply)
        if (speakAlways && voiceCapable) {
          try {
            const audio = await speaker!.synthesize(reply)
            await responder.sendVoice!(audio)
          } catch (err: any) {
            log("voice", `TTS reply failed: ${err?.message ?? err}`)
          }
        }
      }
      // Silent auto-memory curation (background, non-blocking).
      void reviewAndRemember(channelId, msg.conversationId, msg.text, reply)
    } else {
      const errorPart = parts?.find((p) => p.type === "retry")
      const rawErr = hardError || (errorPart as any)?.error?.data?.message || "No text response"
      await statusHandle.finalize(`${modelLabel}\n⚠️ ${String(rawErr).slice(0, 80)}`).catch(() => {})
      // Always tell the user something actionable instead of a silent dead end.
      const pin = pinnedModel ? `${pinnedModel.providerID}/${pinnedModel.modelID}` : "the model"
      await responder
        .sendText(
          hardError
            ? hardErrorNotice(pin, hardError)
            : "⚠️ The model returned no text. Try again, switch with /model, or /new.",
        )
        .catch(() => {})
    }
  }

  // FIFO queue per conversation: two quick messages used to run two prompts
  // CONCURRENTLY against the same session (interleaved turns, racing results).
  // Queue them in arrival order; the user is told when a message is queued.
  // Commands (/stop, /model, …) intentionally BYPASS this queue.
  /**
   * Talk to the agent WHILE its subagents work.
   *
   * The server runs one prompt at a time per session, so the reply is produced in
   * a persistent side session for this conversation, seeded with what the crew is
   * doing (live status + the request that started it). To the user it is the same
   * assistant: it answers anything — questions about the work, or any other
   * subject — and it can read files to check things. The running task is never
   * touched.
   */
  const chatWhileSupervising = async (
    channelId: string,
    conversationId: string,
    msg: Parameters<typeof handleMessageInner>[1],
    responder: Responder,
    busySid: string,
  ): Promise<void> => {
    const key = sessionKey(channelId, conversationId)
    let side = sideSessions.get(key)
    if (side) {
      const alive = await opencode.client.session
        .get({ path: { id: side } })
        .then((r: any) => !!r?.data)
        .catch(() => false)
      if (!alive) {
        sideSessions.delete(key)
        side = undefined
      }
    }
    if (!side) {
      const created = await opencode.client.session
        .create({ body: { title: "side chat (crew working)" } })
        .catch(() => null)
      if (!created?.data) {
        await responder.sendText("📥 Queued — I'll take this right after the current task.").catch(() => {})
        return
      }
      side = (created.data as any).id
      sideSessions.set(key, side!)
    }

    await responder.typing().catch(() => {})
    const prompt =
      "[You are the same assistant this user is talking to. Right now YOUR SUBAGENTS are running a task " +
      "in the background and you are free to talk — the work continues untouched.]\n\n" +
      `[Original request that started the work]\n${turnRequest.get(busySid) ?? "(unknown)"}\n\n` +
      `[Live status of that work — read it before answering questions about progress]\n${liveWorkReport(busySid)}\n\n` +
      `[Project directory] ${DIRECTORY}\n\n` +
      "[User message]\n" + (msg.text || "(empty)") + "\n\n" +
      "Answer the user directly, in their language, as their assistant. If they ask about the work, use the live " +
      "status above (you may READ files in the project to check details, but do NOT edit anything — the crew is " +
      "working on those files right now). For anything else, just answer normally."

    // Cast the same way a normal message would be, so /model and auto both hold.
    let model = config.model && config.model !== "auto" && config.model !== "mix" ? defaultModel : undefined
    let variant = config.effort
    if (config.model === "auto" || config.model === "mix") {
      const cast = config.model === "auto" ? await castForAuto(msg.text) : await castForMix(msg.text)
      model = cast.model
      variant = cast.variant
    }
    const { result } = await promptWithFallback(side!, [{ type: "text", text: prompt }], model, variant, {
      allowFallback: true,
    })
    const sideParts = (result?.data as any)?.parts as Array<{ type: string; text?: string }> | undefined
    const reply = sideParts?.filter((p) => p.type === "text").map((p) => p.text || "").join("\n").trim()
    if (!reply) {
      await responder.sendText("⚠️ I couldn't answer that right now — the crew is still working.").catch(() => {})
      return
    }
    // Voice in → voice out, same rule as the main conversation.
    if ((msg as any).audio && speaker && responder.sendVoice) {
      try {
        await responder.sendVoice(await speaker.synthesize(reply))
        return
      } catch {
        /* fall through to text */
      }
    }
    await responder.sendText(reply).catch(() => {})
  }

  const turnQueues = new Map<string, Promise<void>>()
  const handleMessage = (
    channelId: string,
    msg: Parameters<typeof handleMessageInner>[1],
    responder: Responder,
  ): Promise<void> => {
    const qkey = `${channelId}:${msg.conversationId}`
    const prev = turnQueues.get(qkey)
    if (prev) {
      const busySid = sessionMap.get(sessionKey(channelId, msg.conversationId))
      if (busySid && statusHandles.has(busySid)) {
        // The agent only DISPATCHED subagents and is idle itself → the
        // conversation stays fully open: talk to it about anything, and it can
        // look at what the crew is doing. Nothing is queued, nothing interrupted.
        if (parentSupervising(busySid)) {
          void chatWhileSupervising(channelId, msg.conversationId, msg, responder, busySid).catch(() => {})
          return Promise.resolve()
        }
        // The agent is doing the work ITSELF → messages queue. A progress
        // question is still answered instantly from live state (free, no model).
        if (STATUS_QUESTION.test(msg.text ?? "")) {
          void responder.sendText(liveWorkReport(busySid)).catch(() => {})
          return Promise.resolve()
        }
      }
      void responder
        .sendText("📥 Queued — I'm working on the previous task myself; I'll take this next.")
        .catch(() => {})
    }
    const run = (prev ?? Promise.resolve()).then(() => handleMessageInner(channelId, msg, responder))
    const cleanup = () => {
      if (turnQueues.get(qkey) === tracked) turnQueues.delete(qkey)
    }
    const tracked: Promise<void> = run.then(cleanup, cleanup)
    turnQueues.set(qkey, tracked)
    return run
  }

  // ---------------------------------------------------------------------------
  // Auto-memory — a silent background "curator". After each turn it forks a
  // cheap review (the router casts it to a stunt double) that decides what
  // durable facts are worth keeping, and appends them to AGENTS.md on its own —
  // no /remember needed. Fire-and-forget so it never blocks the reply.
  // ---------------------------------------------------------------------------
  const reviewAndRemember = async (channelId: string, conversationId: string, userText: string, replyText: string) => {
    if (!autoMemory) return
    try {
      const key = `${channelId}:${conversationId}`
      let rsid = reviewSessions.get(key)
      if (!rsid) {
        const created = await opencode.client.session.create({ body: { title: "auto-memory review" } })
        if (created.error || !created.data) return
        rsid = created.data.id
        reviewSessions.set(key, rsid)
      }
      const prompt =
        "You are a silent curator for a coding agent. From the exchange below, output TWO sections, exactly:\n" +
        "PROJECT:\n- durable facts about THIS project (decisions, conventions, where things live) — or NONE\n" +
        "USER:\n- durable facts about the USER across all projects (preferences, identity, working style, tools " +
        "they like) — or NONE\n\n" +
        "Max 5 bullets per section. Ignore greetings, one-off chatter, and transient task details.\n\n" +
        `User: ${userText}\n\nAssistant: ${replyText}`
      // No explicit model → the Hollywood router casts this simple task to a cheap double.
      const res = await opencode.client.session
        .prompt({ path: { id: rsid }, body: { parts: [{ type: "text", text: prompt }] } as any })
        .catch(() => null)
      const out = (((res as any)?.data?.parts ?? []) as any[])
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
        .trim()
      if (!out) return

      const bulletsOf = (s: string | undefined) =>
        (s ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2).trim())
          .filter((b) => b && !/^none\b/i.test(b))

      const projM = out.match(/PROJECT:\s*([\s\S]*?)(?=USER:|$)/i)
      const userM = out.match(/USER:\s*([\s\S]*)$/i)

      // Append new bullets to the WORKING section (capped) and to the LONG-TERM
      // store (uncapped — nothing is ever lost, it just leaves the context).
      const appendBullets = (
        file: string,
        header: string,
        bullets: string[],
        label: string,
        scope: string,
        cap: number,
      ) => {
        if (!bullets.length) return
        let content = ""
        try { content = fs.readFileSync(file, "utf8") } catch { /* new file */ }
        for (const b of bullets) memory.add(scope, b)
        const existing = sectionBullets(content, header)
        const fresh = bullets.map((b) => b.trim()).filter((b) => b && !existing.includes(b))
        if (!fresh.length) return
        let working = [...existing, ...fresh]
        if (working.length > cap) working = working.slice(working.length - cap) // rotate: oldest fall off (kept long-term)
        content = writeSection(content, header, working)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content)
        log("memory", `auto-saved ${fresh.length} ${label} fact(s) (working ${working.length}/${cap})`)
      }

      // Project facts → project AGENTS.md; user profile → global AGENTS.md.
      appendBullets(
        path.join(DIRECTORY, "AGENTS.md"),
        "## Auto-memory",
        bulletsOf(projM?.[1]),
        "project",
        DIRECTORY,
        WORKING_CAP_PROJECT,
      )
      appendBullets(
        path.join(os.homedir(), ".config", "opencode", "AGENTS.md"),
        "## About the user",
        bulletsOf(userM?.[1]),
        "user-profile",
        MEM_SCOPE_USER,
        WORKING_CAP_USER,
      )

      // Autonomous skill creation: if the task taught a reusable procedure,
      // distil it into a new skill (global skills dir). Gated on substantial
      // replies so chitchat never spawns skills.
      if (replyText.length > 400) {
        const skillPrompt =
          "If the exchange below demonstrates a REUSABLE, GENERAL procedure worth saving as a skill for future " +
          "tasks (not a one-off answer), output EXACTLY:\nNAME: <kebab-case-name>\nDESCRIPTION: <one sentence: when " +
          "to use it>\nBODY:\n<concise markdown steps>\n\nOtherwise output EXACTLY: NONE\n\n" +
          `User: ${userText}\n\nAssistant: ${replyText}`
        const sres = await opencode.client.session
          .prompt({ path: { id: rsid }, body: { parts: [{ type: "text", text: skillPrompt }] } as any })
          .catch(() => null)
        const sout = (((sres as any)?.data?.parts ?? []) as any[])
          .filter((p) => p.type === "text").map((p) => p.text || "").join("\n").trim()
        const nameM = sout.match(/NAME:\s*([a-z0-9][a-z0-9-]{1,48})/i)
        const descM = sout.match(/DESCRIPTION:\s*(.+)/i)
        const bodyM = sout.match(/BODY:\s*([\s\S]+)$/i)
        if (!/^none\b/i.test(sout) && nameM && descM && bodyM) {
          const name = nameM[1]!.toLowerCase()
          const dir = path.join(os.homedir(), ".config", "opencode", "skills", "auto", name)
          if (!fs.existsSync(path.join(dir, "SKILL.md"))) {
            fs.mkdirSync(dir, { recursive: true })
            const md = `---\nname: ${name}\ndescription: ${descM[1]!.trim()}\n---\n\n${bodyM[1]!.trim()}\n`
            fs.writeFileSync(path.join(dir, "SKILL.md"), md)
            log("memory", `auto-created skill: ${name}`)
          }
        }
      }
    } catch (err: any) {
      log("memory", `auto-memory review failed: ${err?.message ?? err}`)
    }
  }

  // ---------------------------------------------------------------------------
  // runPrompt — unattended (Phase C cron). Auto-approves permissions, returns text.
  // ---------------------------------------------------------------------------

  const autoResolveUnattended = async (sessionId: string) => {
    const gp = await opencodeV2.permission.list({}).catch(() => null)
    for (const r of (((gp?.data as any) ?? []) as any[])) {
      if (r.sessionID === sessionId)
        await opencodeV2.permission.reply({ requestID: r.id, reply: "always" }).catch(() => {})
    }
    const sp = await opencodeV2.v2.session.permission.list({ sessionID: sessionId }).catch(() => null)
    for (const r of (((sp?.data as any)?.data ?? []) as any[])) {
      await opencodeV2.v2.session.permission.reply({ sessionID: sessionId, requestID: r.id, reply: "always" }).catch(() => {})
    }
    const qs = await opencodeV2.question.list({}).catch(() => null)
    for (const q of (((qs?.data as any) ?? []) as any[])) {
      if (q.sessionID !== sessionId) continue
      const answers: string[][] = q.questions?.map((qq: any) => (qq.options?.[0]?.label ? [qq.options[0].label] : ["ok"])) ?? []
      await opencodeV2.question.reply({ requestID: q.id, answers }).catch(() => {})
    }
  }

  const runPrompt = async (channelId: string, conversationId: string, text: string): Promise<string> => {
    const sessionId = await getOrCreateSession(channelId, conversationId)
    if (!sessionId) return "⚠️ Could not create a session."
    const poller = setInterval(() => { void autoResolveUnattended(sessionId) }, 3000)
    const pinnedModel = config.model !== "auto" ? defaultModel : undefined
    const { result } = await promptWithFallback(sessionId, [{ type: "text", text }], pinnedModel)
    clearInterval(poller)
    await autoResolveUnattended(sessionId)
    if ((result as any).error || !result.data) return "⚠️ The scheduled task failed."
    const parts = (result.data as any).parts as Array<{ type: string; text?: string }> | undefined
    return parts?.filter((p) => p.type === "text").map((p) => p.text || "").join("\n").trim() || "(no text response)"
  }

  // ---------------------------------------------------------------------------
  // handleCommand
  // ---------------------------------------------------------------------------

  const handleCommand = async (
    channelId: string,
    command: string,
    args: string,
    msg: { conversationId: string; userId: string; text: string },
    responder: Responder,
  ) => {
    const { conversationId } = msg
    const sid = currentSession(channelId, conversationId)

    switch (command) {
      // --- start / help ---
      case "start": {
        await responder.sendText(
          "🎬 Hollywood Code — remote control\n" +
            "Send me a message and I'll work on your project.\n\n" +
            "/new · /clear · /sessions · /status · /stop · /model · /undo · /redo · /fork\n" +
            "/rename · /compact · /export · /copy · /agents · /skills\n" +
            "/review · /init · /share · /unshare · /move · /thinking\n" +
            "/variants · /autostart · /org\n" +
            "/goal · /loop · /debug\n" +
            "/doctor · /rewind · /permissions · /context · /help",
        )
        break
      }

      case "help": {
        await responder.sendText(
          "🎬 Commands:\n" +
            "/new · /clear — fresh session\n/sessions — list or switch session\n/status — current session\n/stop — abort task\n" +
            "/model — show or change model (/model auto = router)\n/cost — savings report\n/undo — undo last\n/fork — fork session\n/rename — rename session\n" +
            "/compact — compact session\n/export — export transcript\n/copy — copy transcript\n/agents — list agents\n" +
            "/skills — list skills\n/init — init with AGENTS.md\n/share — share session\n/review — review changes\n" +
            "/move — change project dir\n/remote — connection status\n" +
            "/mode <ask|auto-edit|plan|bypass|auto> — permission mode\n" +
            "/autoallow — on: approve everything · off: ask here\n" +
            "/effort · /thinking — reasoning effort for the pinned model\n" +
            "/mix — cross-provider auto-router (on|off|set tiers)\n" +
            "/autocompact <50-99>|on|off — auto-compact threshold\n" +
            "/schedule <cron> | <prompt> — run a task on a schedule\n/jobs — list scheduled · /unschedule <id>\n" +
            "/recall <keywords> — search past sessions\n/remember <fact> — save to AGENTS.md memory\n" +
            "/automemory on|off — agent curates memory automatically\n" +
            "/memory — memory status · /memory search <q> · /memory curate\n" +
            "/personality <name> — set agent personality\n/insights [days] — usage insights\n/compress — compact context\n" +
            "/voice on|off — speak replies aloud (free local Piper)\n" +
            "/profile — what I've learned about you\n/curate — archive unused auto-skills\n" +
            "/tools — enable/disable native tools (browser, …)\n" +
            "/image <path> — send a local image to this chat (agent can too, via its send_image tool)\n" +
            "/unshare — stop sharing the active session\n" +
            "/redo — redo a previously undone revert\n" +
            "/variants — switch model variant (picker)\n" +
            "/autostart on|off|status — manage OS auto-start of the gateway\n" +
            "/org — switch active Console organization\n" +
            "/goal [condition|off|clear] — set/show/clear a per-session goal\n" +
            "/loop <seconds> | <prompt> — run a prompt on an interval; /loop stop to cancel\n" +
            "/debug on|off — toggle verbose logging\n" +
            "/doctor — diagnose install (bins, deps, auth, server)\n" +
            "/rewind — roll back to a past user message (picker)\n" +
            "/permissions [tool allow|ask|deny] — view/edit tool permissions\n" +
            "/context — show context-window token usage for this session\n\nSend any text to work on your project.",
        )
        break
      }

      // --- session management ---
      case "new":
      case "clear": {
        const key = sessionKey(channelId, conversationId)
        sessionMap.delete(key)
        sideSessions.delete(key) // the side chat belongs to the old session too
        saveStore()
        await responder.sendText("🆕 New session. Send your next message to begin.")
        break
      }

      case "status": {
        if (!sid) { await responder.sendText("No active session."); break }
        // Commands bypass the turn queue, so /status works DURING a long task:
        // lead with the live work report (subagents, their models, files).
        if (statusHandles.has(sid)) {
          await responder.sendText(liveWorkReport(sid))
          break
        }
        const s = await opencode.client.session.get({ path: { id: sid } }).catch(() => null)
        const m = s?.data ? `${(s.data as any).title} (${sid.slice(0, 12)}…)` : sid
        const modelLine =
          config.model === "auto"
            ? `🎬 auto — director-first (strongest of ${config.autoProvider ?? "free provider"}, high effort)`
            : config.model === "mix"
              ? "🎚️ mix (cross-provider)"
              : defaultModel
                ? `${defaultModel.providerID}/${defaultModel.modelID}`
                : "auto"
        await responder.sendText(
          `📁 ${m}\n📂 ${DIRECTORY}\n🧠 ${modelLine}${config.effort ? ` · effort: ${config.effort}` : ""}\n🎛️ ${MODE_LABELS[mode]}`,
        )
        break
      }

      case "stop": {
        if (!sid) { await responder.sendText("No active session."); break }
        await opencode.client.session.abort({ path: { id: sid } }).catch(() => {})
        await clearPending(sid) // unblock any stuck permission/question without losing context
        await responder.sendText("⏹️ Stopped. The session is unblocked — your context is kept.")
        break
      }

      case "rename": {
        if (!args) { await responder.sendText("Usage: /rename <new name>"); break }
        if (!sid) { await responder.sendText("No active session."); break }
        await opencode.client.session.update({ path: { id: sid }, body: { title: args } as any }).catch(() => {})
        await responder.sendText(`✏️ Renamed to: ${args}`)
        break
      }

      case "fork": {
        if (!sid) { await responder.sendText("No active session."); break }
        const name = args || `Fork of ${sid.slice(0, 8)}`
        // Fork's body only accepts {messageID} — a title there was silently
        // discarded. Fork first, then apply the name via session.update.
        const f = await opencode.client.session.fork({ path: { id: sid }, body: {} as any }).catch(() => null)
        if (!f?.data) { await responder.sendText("⚠️ Fork failed."); break }
        const newID = (f.data as any).id
        await opencode.client.session.update({ path: { id: newID }, body: { title: name } as any }).catch(() => {})
        const key = sessionKey(channelId, conversationId)
        sessionMap.set(key, newID)
        saveStore()
        await responder.sendText(`🔀 Forked into "${name}" — you're now on the new session.`)
        break
      }

      case "undo": {
        if (!sid) { await responder.sendText("No active session."); break }
        // revert REQUIRES a messageID (like /rewind passes) — calling it bare
        // 400'd into a swallowed .catch and still replied "Undone" (false
        // success). Find the last USER message and revert to it for real.
        const msgs = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
        const lastUser = (((msgs?.data as any[]) ?? []) as any[])
          .filter((m: any) => (m.role ?? m.info?.role) === "user")
          .pop()
        const messageID: string | undefined = lastUser?.id ?? lastUser?.info?.id
        if (!messageID) { await responder.sendText("Nothing to undo yet."); break }
        const r = await opencode.client.session
          .revert({ path: { id: sid }, body: { messageID } })
          .then(() => true)
          .catch(() => false)
        await responder.sendText(r ? "↩️ Undone — last exchange reverted. /redo restores it." : "⚠️ Undo failed — try /rewind for a picker.")
        break
      }

      case "compact":
      case "compress": {
        if (!sid) { await responder.sendText("No active session."); break }
        const compactModel = defaultModel ?? freeModel
        if (!compactModel) {
          await responder.sendText("⚠️ No model configured — run /model first, then /compact.")
          break
        }
        await responder.sendText("📦 Compacting — summarizing older context to free space...")
        // Mirror the TUI: v1 summarize WITH a model (the summary is model-generated).
        const compRes = await opencode.client.session
          .summarize({ path: { id: sid }, body: { providerID: compactModel.providerID, modelID: compactModel.modelID } })
          .then(() => ({ ok: true as const }))
          .catch((err: any) => {
            console.error("[compact] summarize failed:", err)
            return { ok: false as const, error: err }
          })
        if (!compRes.ok) {
          const msg = (compRes.error as any)?.message ?? String((compRes.error as any) ?? "unknown error")
          await responder.sendText(`⚠️ Compaction failed: ${msg} — try again, or /new for a fresh session.`)
          break
        }
        // Report the real before → after so the user sees the reduction. The big input
        // of the new summary message was a one-time read; the forward context is its
        // output (the summary text). Compaction takes full effect on the next message.
        const after = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
        const infos = ((after?.data as any[]) ?? []).map((m) => m.info ?? m)
        const summaryMsg = [...infos].reverse().find(
          (i) => i.role === "assistant" && (i.summary === true || i.mode === "compaction" || i.agent === "compaction"),
        )
        const prevTurn = [...infos]
          .reverse()
          .find(
            (i) =>
              i.role === "assistant" &&
              (i.tokens?.output ?? 0) > 0 &&
              !(i.summary === true || i.mode === "compaction" || i.agent === "compaction"),
          )
        const tk = (i: any) =>
          i ? (i.tokens?.input ?? 0) + (i.tokens?.cache?.read ?? 0) + (i.tokens?.cache?.write ?? 0) + (i.tokens?.output ?? 0) + (i.tokens?.reasoning ?? 0) : 0
        const before = tk(prevTurn)
        const newBase = summaryMsg ? (summaryMsg.tokens?.output ?? 0) + (summaryMsg.tokens?.reasoning ?? 0) : 0
        if (before > 0 && newBase > 0) {
          await responder.sendText(
            `✅ Session compacted — older messages summarized.\nContext: ${before.toLocaleString()} → ~${newBase.toLocaleString()} tokens (full effect on your next message). Check /context.`,
          )
        } else {
          await responder.sendText("✅ Session compacted — older messages summarized. Reduced context applies on your next message; check /context.")
        }
        break
      }

      case "voice": {
        const a = args.toLowerCase()
        if (a !== "on" && a !== "off") {
          // Two independent legs: speak-replies (TTS) and transcription (STT).
          const sttSource = config.voice?.apiKey
            ? "API key"
            : config.voice && localSttAvailable(config.voice)
              ? "local whisper"
              : null
          const sttLine = sttSource
            ? `🎤 Transcription: ON (${sttSource}) — send a voice note and I'll read it.`
            : "🎤 Transcription: OFF — install offline whisper (scripts/install-whisper.ps1) or set a voice API key."
          await responder.sendText(
            `🔊 Speak-replies (TTS): ${speakAlways ? "ON" : "OFF"} — /voice on|off (free local Piper).\n${sttLine}`,
          )
          break
        }
        speakAlways = a === "on"
        if (!config.voice) config.voice = { ttsEngine: "piper" }
        config.voice.speakReplies = speakAlways
        saveGatewayConfig(config)
        if (speakAlways && !speaker) speaker = createSpeaker(config.voice)
        await responder.sendText(
          speakAlways
            ? "🔊 Voice ON — I'll speak my replies (Piper, local & free). Make sure Piper is installed."
            : "🔊 Voice OFF.",
        )
        break
      }

      case "personality": {
        const want = args.trim().toLowerCase()
        if (!want) {
          const list = Object.keys(PERSONALITIES).map((n) => (n === personality ? `👉 ${n}` : n)).join(", ")
          await responder.sendText(`🎭 Personality: ${personality}\nAvailable: ${list}\nUsage: /personality <name>`)
          break
        }
        if (PERSONALITIES[want] === undefined) {
          await responder.sendText(`Unknown personality. Available: ${Object.keys(PERSONALITIES).join(", ")}`)
          break
        }
        personality = want
        config.personality = want
        saveGatewayConfig(config)
        await responder.sendText(`🎭 Personality set to: ${want}`)
        break
      }

      case "insights": {
        const days = parseInt(args.trim(), 10) || 7
        const since = Date.now() - days * 86400000
        const list = await opencode.client.session.list({}).catch(() => null)
        const all: any[] = (list?.data as any[]) ?? []
        // (A leftover "|| true" used to disable this date filter entirely —
        // /insights 1 and /insights 30 returned identical numbers.)
        const recent = all.filter((s: any) => (s.time?.updated ?? s.time?.created ?? 0) >= since).slice(0, 50)
        let sessions = 0
        let assistantMsgs = 0
        const models = new Map<string, number>()
        for (const s of recent) {
          const msgs = await opencode.client.session.messages({ path: { id: s.id } }).catch(() => null)
          const data = (msgs?.data as any[]) ?? []
          let used = false
          for (const m of data) {
            const info = m.info ?? m
            if (info.role === "assistant" && info.modelID) {
              assistantMsgs++
              used = true
              const k = `${info.providerID}/${info.modelID}`
              models.set(k, (models.get(k) ?? 0) + 1)
            }
          }
          if (used) sessions++
        }
        const top = [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        const lines = top.map(([k, n]) => `  ${k}: ${n} scenes`)
        await responder.sendText(
          `📊 Insights (last ${days}d)\n` +
            `Sessions with activity: ${sessions}\nAssistant turns: ${assistantMsgs}\n` +
            `By model:\n${lines.join("\n") || "  (none)"}\n` +
            `Tip: /cost shows how much the stunt doubles saved.`,
        )
        break
      }

      // --- sessions picker ---
      case "session":
      case "sessions":
      case "s": {
        if (args) {
          // Validate the id exists BEFORE switching — a typo used to point the
          // conversation at a nonexistent session and every prompt then failed.
          const target = await opencode.client.session.get({ path: { id: args } }).catch(() => null)
          if (!target?.data) {
            await responder.sendText(`⚠️ No session found with id "${args}" — run /sessions to pick from the list.`)
            break
          }
          const key = sessionKey(channelId, conversationId)
          sessionMap.delete(key)
          sessionMap.set(key, args)
          saveStore()
          await responder.sendText(`✅ Switched to: ${(target.data as any).title || args}\nSend a message — I'll continue with this session's history.`)
          break
        }
        const list = await opencode.client.session.list({}).catch(() => null)
        if (!list?.data) { await responder.sendText("No sessions found."); break }
        const all: any[] = list.data as any[]
        const top = all.slice(0, 20)
        // Number each option so we can map the choice back to the EXACT session.
        // (The old code parsed an 8-hex-char id from the label, but opencode ids
        // are "ses_..." so that regex never matched — picking a session silently
        // did nothing, the conversation never switched, and context "didn't load".)
        const options = top.map(
          (s: any, i: number) => `${i + 1}. ${s.id === sid ? "👉 " : ""}${(s.title || "untitled").slice(0, 48)}`,
        )
        if (!options.length) { await responder.sendText("No sessions found."); break }
        const chosen = await responder.askQuestion({ question: "📋 Sessions — choose to switch:", options })
        const idxM = chosen.match(/^(\d+)\./)
        const target = idxM
          ? top[parseInt(idxM[1]!, 10) - 1]
          : top.find((s: any) => chosen.includes((s.title || "untitled").slice(0, 48)))
        if (target) {
          const key = sessionKey(channelId, conversationId)
          sessionMap.delete(key)
          sessionMap.set(key, target.id)
          saveStore()
          await responder.sendText(
            `✅ Switched to: ${target.title || target.id}\nSend a message — I'll continue with this session's full history.`,
          )
        } else {
          await responder.sendText("Couldn't match that choice. Try `/sessions <full-id>`.")
        }
        break
      }

      // --- cost / usage ---
      case "cost":
      case "usage": {
        if (!sid) { await responder.sendText("No active session."); break }
        const msgs = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
        if (!msgs?.data) { await responder.sendText("No messages yet."); break }
        const prov = await opencode.client.config.providers().catch(() => null)
        const providers: any[] = (prov?.data as any)?.providers ?? []
        const rateOf = (pid: string, mid: string) =>
          providers.find((p: any) => p.id === pid)?.models?.[mid]?.cost ?? null

        type Agg = { scenes: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
        const byModel = new Map<string, Agg>()
        for (const m of msgs.data as any[]) {
          const info = m.info ?? m
          if (info.role !== "assistant" || !info.modelID) continue
          const key = `${info.providerID}/${info.modelID}`
          const t = info.tokens ?? {}
          const agg = byModel.get(key) ?? { scenes: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
          agg.scenes++
          agg.input += t.input ?? 0
          agg.output += (t.output ?? 0) + (t.reasoning ?? 0)
          agg.cacheRead += t.cache?.read ?? 0
          agg.cacheWrite += t.cache?.write ?? 0
          let cost = info.cost
          if (cost == null) {
            const r = rateOf(info.providerID, info.modelID)
            cost = r
              ? ((t.input ?? 0) * (r.input ?? 0) +
                  ((t.output ?? 0) + (t.reasoning ?? 0)) * (r.output ?? 0) +
                  (t.cache?.read ?? 0) * (r.cache?.read ?? 0) +
                  (t.cache?.write ?? 0) * (r.cache?.write ?? 0)) / 1e6
              : 0
          }
          agg.cost += cost
          byModel.set(key, agg)
        }
        if (!byModel.size) { await responder.sendText("No assistant messages yet."); break }

        let starKey = ""
        let starRate: any = null
        let starScore = -1
        for (const key of byModel.keys()) {
          const [pid, ...rest] = key.split("/")
          const r = rateOf(pid!, rest.join("/"))
          const score = r ? (r.input ?? 0) + (r.output ?? 0) : 0
          if (score > starScore) { starScore = score; starKey = key; starRate = r }
        }

        const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n))
        const usd = (n: number) => "$" + n.toFixed(4)
        let total = 0
        let allStar = 0
        const lines: string[] = []
        for (const [key, a] of byModel) {
          total += a.cost
          allStar += starRate
            ? (a.input * (starRate.input ?? 0) +
                a.output * (starRate.output ?? 0) +
                a.cacheRead * (starRate.cache?.read ?? 0) +
                a.cacheWrite * (starRate.cache?.write ?? 0)) / 1e6
            : 0
          lines.push(
            `${key === starKey ? "⭐" : "🤸"} ${key}\n      ${a.scenes} scene${a.scenes > 1 ? "s" : ""} · ${fmtK(a.input + a.cacheRead)} in · ${fmtK(a.output)} out · ${usd(a.cost)}`,
          )
        }
        const saved = Math.max(0, allStar - total)
        const pct = allStar > 0 ? Math.round((saved / allStar) * 100) : 0
        const report =
          "🎬 Hollywood cost report — this session\n\n" +
          lines.join("\n") +
          `\n\n💵 Total: ${usd(total)}` +
          `\n⭐ All-star (${starKey} in every scene): ${usd(allStar)}` +
          `\n🤑 Saved by stunt doubles: ${usd(saved)}${allStar > 0 ? ` (${pct}%)` : ""}` +
          (allStar === 0 ? "\nℹ️ Free models — every scene cost $0, savings show with paid providers." : "")
        await responder.sendText(report)
        break
      }

      // --- export / copy ---
      case "export":
      case "copy": {
        if (!sid) { await responder.sendText("No active session."); break }
        const msgs = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
        if (!msgs?.data) { await responder.sendText("No messages."); break }
        // Messages come as {info, parts} — reading m.role printed "[undefined]"
        // on every line. Read the real role, and ship long transcripts as a .md
        // FILE instead of flooding the chat with dozens of 4096-char messages.
        const lines = (msgs.data as any[]).map((m: any) => {
          const info = m.info ?? m
          const body = (m.parts as any[] | undefined)
            ?.filter((p: any) => p.type === "text")
            .map((p: any) => p.text || "")
            .join("\n")
            .trim()
          return `## ${info.role ?? "?"}\n\n${body || "(no text)"}`
        })
        const transcript = lines.join("\n\n") || "(empty transcript)"
        if (transcript.length > 3500 && responder.sendFile) {
          await responder.sendFile(
            new TextEncoder().encode(`# Transcript — ${sid}\n\n${transcript}\n`),
            `transcript-${sid.slice(0, 12)}.md`,
            "📄 Full transcript attached",
          )
        } else {
          await responder.sendText(transcript)
        }
        break
      }

      // --- agents / skills ---
      case "agents": {
        const list = await opencodeV2.v2.agent.list({}).catch(() => null)
        const agents: any[] = (list?.data as any)?.data
        if (!agents?.length) { await responder.sendText("No agents available."); break }
        // AgentV2Info has no .name — use .description (printing "build — build" before).
        const rows = agents.map((a: any) => (a.description ? `${a.id} — ${a.description}` : String(a.id)))
        await responder.sendText(`🧠 Agents:\n${rows.join("\n")}`)
        break
      }

      case "skills": {
        const list = await opencodeV2.v2.skill.list({}).catch(() => null)
        const skills: any[] = (list?.data as any)?.data
        if (!skills?.length) { await responder.sendText("No skills available."); break }
        const names = skills.map((s: any) => s.name || s.id).filter(Boolean).sort()
        const shown = names.slice(0, 60)
        const more = names.length > shown.length ? `\n…and ${names.length - shown.length} more` : ""
        await responder.sendText(`🛠 ${names.length} skills available:\n${shown.join(", ")}${more}`)
        break
      }

      // --- init / share / review ---
      case "init": {
        if (!sid) { await responder.sendText("No active session."); break }
        // The route requires {modelID, providerID, messageID} — the old call sent
        // {directory} (not a body field), 400'd silently and lied "initialized".
        const initModel = defaultModel ?? freeModel
        if (!initModel) { await responder.sendText("⚠️ Pin a model first with /model, then /init."); break }
        const initMsgID = `msg_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 12)}`
        await responder.sendText("📝 Analyzing the project and generating AGENTS.md…")
        const initOk = await opencode.client.session
          .init({
            path: { id: sid },
            body: { providerID: initModel.providerID, modelID: initModel.modelID, messageID: initMsgID } as any,
          })
          .then((r: any) => !r?.error)
          .catch(() => false)
        await responder.sendText(initOk ? "✅ AGENTS.md created — the project is initialized." : "⚠️ Init failed — try again or check the model with /model.")
        break
      }

      case "share": {
        if (!sid) { await responder.sendText("No active session."); break }
        const res = await opencode.client.session.share({ path: { id: sid } }).catch(() => null)
        if (!res?.data) { await responder.sendText("⚠️ Share failed."); break }
        // The share URL lives at data.share.url (data.url is undefined — this
        // used to print the session ID instead of the actual link).
        const d = res.data as any
        const url = d.share?.url ?? d.url
        await responder.sendText(url ? `🔗 Shared: ${url}` : "⚠️ Shared, but no URL came back — try /share again.")
        break
      }

      case "review": {
        if (!sid) { await responder.sendText("No active session."); break }
        // The diff endpoint returns Array<FileDiff{file,before,after,additions,
        // deletions}> — the old code read a nonexistent .diff and dumped raw JSON
        // (and printed "[]" for zero changes, since an empty array is truthy).
        const diff = await opencode.client.session.diff({ path: { id: sid } }).catch(() => null)
        const files: any[] = Array.isArray(diff?.data) ? (diff!.data as any[]) : []
        if (!files.length) { await responder.sendText("✅ No changes to review."); break }
        const totalAdd = files.reduce((n, f) => n + (f.additions ?? 0), 0)
        const totalDel = files.reduce((n, f) => n + (f.deletions ?? 0), 0)
        const rows = files.slice(0, 30).map((f) => `📄 ${f.file}  (+${f.additions ?? 0} −${f.deletions ?? 0})`)
        const more = files.length > 30 ? `\n…and ${files.length - 30} more files` : ""
        await responder.sendText(
          `🔍 Changes in this session — ${files.length} file(s), +${totalAdd} −${totalDel}\n\n${rows.join("\n")}${more}\n\nUse /export for full contents.`,
        )
        break
      }

      // --- image (send a local image file to this chat, inline) ---
      case "image": {
        const p = args.trim().replace(/^["']|["']$/g, "")
        if (!p) { await responder.sendText("Usage: /image <absolute path to .png/.jpg/.gif/.webp>"); break }
        if (!responder.sendImage) { await responder.sendText("⚠️ This channel can't display images."); break }
        if (!/\.(png|jpe?g|gif|webp)$/i.test(p)) { await responder.sendText("Only .png/.jpg/.jpeg/.gif/.webp files."); break }
        try {
          const stat = fs.statSync(p)
          if (stat.size > 10 * 1024 * 1024) { await responder.sendText("⚠️ Larger than Telegram's 10MB photo limit."); break }
          await responder.sendImage(fs.readFileSync(p), path.basename(p), `📸 ${path.basename(p)}`)
        } catch {
          await responder.sendText(`⚠️ Could not read: ${p}`)
        }
        break
      }

      // --- unshare ---
      case "unshare": {
        if (!sid) { await responder.sendText("No active session."); break }
        await opencode.client.session.unshare({ path: { id: sid } }).catch(() => {})
        await responder.sendText("🔒 Session is no longer shared.")
        break
      }

      // --- redo ---
      case "redo": {
        if (!sid) { await responder.sendText("No active session."); break }
        await opencode.client.session.unrevert({ path: { id: sid } }).catch(() => {})
        await responder.sendText("↪️ Redo applied — reverted messages restored.")
        break
      }

      // --- effort / variants / thinking (reasoning effort = model variant) ---
      // /thinking used to write a `thinking` field that doesn't exist anywhere in
      // the API (decorative since day one) — it now IS the real feature: the
      // model's reasoning-effort variant.
      case "thinking":
      case "effort":
      case "variants": {
        const curModel = defaultModel
        if (!curModel) {
          await responder.sendText("Pin a model first with /model, then set its reasoning effort.")
          break
        }
        // IMPORTANT: read effort levels from config.providers() (v1) — these are the
        // reasoning-effort variants (none/low/medium/high/xhigh). The v2 model.list()
        // exposes a DIFFERENT "variants" (service tiers like "fast"), which is not
        // what /effort means.
        const prov = await opencode.client.config.providers().catch(() => null)
        const providers: any[] = (prov?.data as any)?.providers ?? []
        const provEntry = providers.find((x: any) => x.id === curModel.providerID)
        const variantsObj: Record<string, any> = provEntry?.models?.[curModel.modelID]?.variants ?? {}
        const options = Object.keys(variantsObj)
        if (!options.length) {
          await responder.sendText(
            `ℹ️ No reasoning effort levels for ${curModel.providerID}/${curModel.modelID}.`,
          )
          break
        }
        // Accept a direct arg (e.g. /effort high); otherwise show a picker.
        let chosen: string | undefined
        const a = args.trim().toLowerCase()
        if (a) {
          chosen = options.find((o) => o.toLowerCase() === a)
          if (!chosen) {
            await responder.sendText(`Unknown effort "${args}". Available: ${options.join(", ")}`)
            break
          }
        } else {
          chosen = await responder.askQuestion({ question: "🎚️ Pick reasoning effort:", options })
          if (!chosen) break // timed out / cancelled
        }
        // The variant is a per-prompt runtime choice (passed in the prompt body),
        // NOT a config field — `model` in opencode.jsonc must be a string. Just
        // store it; promptWithFallback attaches it to each prompt. No config
        // write, no reload (this is what avoided the earlier config corruption).
        config.effort = chosen
        saveGatewayConfig(config)
        await responder.sendText(`🎚️ Effort set to: ${chosen} — applies to your next message.`)
        break
      }

      // --- autostart ---
      case "autostart": {
        const a = args.trim().toLowerCase()
        if (a === "on") {
          const ok = installStartup(DIRECTORY)
          await responder.sendText(ok ? "✅ Auto-start installed — gateway starts at login." : "⚠️ Could not install auto-start.")
          break
        }
        if (a === "off") {
          removeStartup()
          await responder.sendText("🗑 Auto-start removed.")
          break
        }
        // status or no arg
        const active = startupStatus()
        await responder.sendText(
          `⚙️ Auto-start is ${active ? "ON" : "OFF"}\nUsage: /autostart on|off|status`,
        )
        break
      }

      // --- org ---
      case "org": {
        const orgsRes = await opencodeV2.experimental.console.listOrgs().catch(() => null)
        const orgs: any[] = (orgsRes?.data as any)?.orgs ?? (orgsRes?.data as any) ?? []
        if (!Array.isArray(orgs) || orgs.length === 0) {
          await responder.sendText("ℹ️ No switchable organizations found (single-org or not logged in to Console).")
          break
        }
        if (orgs.length === 1) {
          await responder.sendText(`ℹ️ Only one organization available: ${orgs[0]?.orgName ?? orgs[0]?.orgID ?? "(unknown)"}. Nothing to switch.`)
          break
        }
        // The real field is orgName (there is no .name/.id) — the picker was
        // showing raw UUIDs instead of the human-readable names.
        const options = orgs.map((o: any) => String(o.orgName ?? o.orgID ?? "(unknown)"))
        const chosen = await responder.askQuestion({ question: "🏢 Pick an organization:", options })
        if (!chosen) break // timed out / cancelled
        const idx = options.indexOf(chosen)
        const target = orgs[idx]
        if (!target) break
        await opencodeV2.experimental.console.switchOrg({ accountID: target.accountID, orgID: target.orgID ?? target.id }).catch(() => {})
        await responder.sendText(`✅ Switched to org: ${chosen}`)
        break
      }

      // --- mix (cross-provider auto-router; a 3rd mode of the model selector) ---
      case "mix": {
        const a = args.trim().toLowerCase()
        const tiers = ["low", "mid", "high"] as const
        const clearPinnedFile = () => {
          try {
            const p = path.join(DIRECTORY, "opencode.jsonc")
            const raw = readJsonc(p)
            delete raw.model
            fs.writeFileSync(p, JSON.stringify(raw, null, 2))
          } catch { /* best-effort */ }
        }
        if (!a) {
          const rows = tiers.map((t) => `  ${t}: ${config.mixTable?.[t] ?? "(auto)"}`)
          await responder.sendText(
            `🎚️ Mix model (cross-provider) is ${config.model === "mix" ? "ON" : "OFF"}\n${rows.join("\n")}\n\n` +
              "Usage:\n  /mix on | off\n  /mix low|mid|high <provider/model>\n  /mix auto  (re-detect all tiers)",
          )
          break
        }
        if (a === "on") {
          if (config.model !== "mix") config.preMix = config.model
          config.model = "mix"
          saveGatewayConfig(config)
          clearPinnedFile()
          await responder.sendText("🎚️ Mix ON — easy → free, hard → best paid model across providers. /mix to see the table.")
          break
        }
        if (a === "off") {
          const restore = config.preMix && config.preMix !== "mix" ? config.preMix : "auto"
          config.model = restore
          saveGatewayConfig(config)
          if (restore !== "auto" && restore.includes("/")) {
            defaultModel = { providerID: restore.slice(0, restore.indexOf("/")), modelID: restore.slice(restore.indexOf("/") + 1) }
            syncModelToFile(restore)
            await responder.sendText(`🎚️ Mix OFF — back to pinned ${restore}.`)
          } else {
            clearPinnedFile()
            await responder.sendText("🎚️ Mix OFF — back to per-provider auto.")
          }
          break
        }
        if (a === "auto") {
          config.mixTable = undefined
          saveGatewayConfig(config)
          await responder.sendText("🎚️ Mix table reset — all tiers auto-detected (free for easy, best paid for hard).")
          break
        }
        // /mix <tier> <provider/model>
        const parts2 = args.trim().split(/\s+/)
        const tier = parts2[0]?.toLowerCase() as (typeof tiers)[number] | undefined
        const ref = parts2.slice(1).join(" ").trim()
        if (!tier || !tiers.includes(tier) || !ref.includes("/")) {
          await responder.sendText("Usage: /mix low|mid|high <provider/model>  ·  /mix on|off|auto")
          break
        }
        if (!config.mixTable) config.mixTable = {}
        config.mixTable[tier] = ref
        saveGatewayConfig(config)
        await responder.sendText(`🎚️ Mix ${tier} → ${ref}${config.model === "mix" ? "" : "  (turn on with /mix on)"}`)
        break
      }

      // --- model ---
      case "model": {
        if (args === "mix") {
          if (config.model !== "mix") config.preMix = config.model
          config.model = "mix"
          config.effort = undefined
          saveGatewayConfig(config)
          try {
            const p = path.join(DIRECTORY, "opencode.jsonc")
            const raw = readJsonc(p)
            delete raw.model
            fs.writeFileSync(p, JSON.stringify(raw, null, 2))
          } catch { /* best-effort */ }
          await responder.sendText("🎚️ MIX mode — cross-provider: easy → free, hard → best paid model. Configure with /mix.")
          break
        }
        if (args === "auto") {
          config.model = "auto"
          config.effort = undefined // variant is model-specific; reset on model change
          saveGatewayConfig(config)
          try {
            const p = path.join(DIRECTORY, "opencode.jsonc")
            const raw = readJsonc(p)
            delete raw.model
            fs.writeFileSync(p, JSON.stringify(raw, null, 2))
          } catch { /* best-effort */ }
          await responder.sendText(
            `🎬 AUTO mode — DIRECTOR-FIRST in ${config.autoProvider ?? "your provider"}:\n` +
              "the provider's strongest model (high effort) always talks to you. On heavy tasks it " +
              "dispatches the stunt double (second-best) to execute, the star verifies, and the " +
              "director gives you the final cut. Every reply is labeled with what played.\n" +
              "Pin again anytime with /model providerID/modelID",
          )
          break
        }
        if (args) {
          const parts = args.split("/")
          if (parts.length < 2) { await responder.sendText("Invalid format. Use: /model providerID/modelID (or /model auto)"); break }
          defaultModel = { providerID: parts[0]!, modelID: parts.slice(1).join("/") }
          config.model = args
          config.effort = undefined // variant is model-specific; reset on model change
          config.autoProvider = parts[0]! // /model auto routes within this provider
          saveGatewayConfig(config)
          await opencode.client.config.update({ body: { model: args } as any }).catch(() => {})
          syncModelToFile(args)
          await responder.sendText(`✅ Model pinned to ${args}\nBack to auto-casting anytime: /model auto`)
          break
        }
        // no args: two-step picker (provider → model). A flat list of every
        // model overflowed the inline-keyboard's 8-button cap, so once a paid
        // provider with many models was connected its models filled all 8 slots
        // and hid the free opencode models. Picking the provider first keeps each
        // step within the cap so nothing is ever hidden.
        const prov = await opencode.client.config.providers().catch(() => null)
        if (!prov?.data) { await responder.sendText("Could not fetch providers."); break }
        const providers: any[] = (prov.data as any).providers ?? []
        if (!providers.length) { await responder.sendText("No providers available."); break }
        const cur =
          config.model === "auto"
            ? "🎬 auto (per-provider router)"
            : config.model === "mix"
              ? "🎚️ mix (cross-provider router)"
              : defaultModel
                ? `${defaultModel.providerID}/${defaultModel.modelID}`
                : "server default"

        // step 1 — provider (plus AUTO and MIX shortcuts)
        const AUTO_LABEL = "🎬 auto (1 provider)"
        const MIX_LABEL = "🎚️ mix (cross-provider)"
        log("engine", `/model: provider step (providers: ${providers.map((p: any) => p.id).join(", ")})`)
        const provChoice = await responder.askQuestion({
          question: `🤖 Current: ${cur}\n\nPick a provider:`,
          options: [AUTO_LABEL, MIX_LABEL, ...providers.map((p: any) => String(p.id))],
        })
        log("engine", `/model: provider chosen = "${provChoice}"`)
        if (!provChoice) break // timed out / cancelled
        if (provChoice === MIX_LABEL) {
          if (config.model !== "mix") config.preMix = config.model
          config.model = "mix"
          saveGatewayConfig(config)
          try {
            const p = path.join(DIRECTORY, "opencode.jsonc")
            const raw = readJsonc(p)
            delete raw.model
            fs.writeFileSync(p, JSON.stringify(raw, null, 2))
          } catch { /* best-effort */ }
          await responder.sendText("🎚️ MIX mode — cross-provider: easy → free, hard → best paid model. Configure with /mix.")
          break
        }
        if (provChoice === AUTO_LABEL) {
          config.model = "auto"
          config.effort = undefined // variant is model-specific; reset on model change
          saveGatewayConfig(config)
          try {
            const p = path.join(DIRECTORY, "opencode.jsonc")
            const raw = readJsonc(p)
            delete raw.model
            fs.writeFileSync(p, JSON.stringify(raw, null, 2))
          } catch { /* best-effort */ }
          await responder.sendText(
            `🎬 AUTO mode — DIRECTOR-FIRST: the strongest model of ${config.autoProvider ?? "your provider"} (high effort) always answers; heavy tasks run the director→double→star pipeline.`,
          )
          break
        }
        const picked = providers.find((p: any) => String(p.id) === provChoice)
        const models = Object.keys(picked?.models || {})
        if (!models.length) { await responder.sendText(`No models for ${provChoice}.`); break }

        // step 2 — model within that provider
        log("engine", `/model: model step for ${provChoice} (${models.length} models)`)
        const modelChoice = await responder.askQuestion({
          question: `📦 ${provChoice} — pick a model:`,
          options: models,
        })
        log("engine", `/model: model chosen = "${modelChoice}"`)
        if (!modelChoice) break // timed out / cancelled
        const chosen = `${provChoice}/${modelChoice}`
        defaultModel = { providerID: provChoice, modelID: modelChoice }
        config.model = chosen
        config.effort = undefined // variant is model-specific; reset on model change
        config.autoProvider = provChoice // /model auto routes within this provider
        saveGatewayConfig(config)
        await opencode.client.config.update({ body: { model: chosen } as any }).catch(() => {})
        syncModelToFile(chosen)
        await responder.sendText(`✅ Model set to ${chosen}`)
        log("engine", `/model: set to ${chosen}`)
        break
      }

      // --- autoallow ---
      // --- mode (unified permission/agent mode selector) ---
      case "mode": {
        const a = args.trim().toLowerCase().replace(/\s+/g, "-")
        const valid: Mode[] = ["ask", "auto-edit", "plan", "bypass", "auto"]
        if (!a) {
          await responder.sendText(
            `🎛️ Current mode: ${MODE_LABELS[mode]}\n\n` +
              valid.map((m) => `  ${m}${m === mode ? "  ← current" : ""}`).join("\n") +
              `\n\nUsage: /mode <ask|auto-edit|plan|bypass|auto>`,
          )
          break
        }
        const aliases: Record<string, Mode> = {
          ask: "ask", confirm: "ask",
          "auto-edit": "auto-edit", autoedit: "auto-edit", edit: "auto-edit", auto_edit: "auto-edit",
          plan: "plan", planning: "plan",
          bypass: "bypass", yolo: "bypass", all: "bypass",
          auto: "auto", smart: "auto",
        }
        const target = aliases[a]
        if (!target) {
          await responder.sendText(`Unknown mode "${args}". Valid: ${valid.join(", ")}`)
          break
        }
        if (target === mode) { await responder.sendText(`Already in ${target} mode.`); break }
        await responder.sendText(`🎛️ Switching to ${target}…`)
        const ok = await applyMode(target)
        await responder.sendText(
          ok ? `✅ ${MODE_LABELS[target]}` : "⚠️ Mode saved, but reload failed — try /move to the same dir.",
        )
        break
      }

      // --- autoallow (legacy alias → mode bypass|ask) ---
      case "autoallow": {
        const arg = args.toLowerCase()
        if (arg !== "on" && arg !== "off") {
          await responder.sendText(
            `🔐 Auto-allow is ${autoAllow ? "ON (bypass)" : "OFF"}.\nThis is now part of /mode — try /mode bypass or /mode ask.\nUsage: /autoallow on|off`,
          )
          break
        }
        const target: Mode = arg === "on" ? "bypass" : "ask"
        if (target === mode) { await responder.sendText(`Already ${arg}.`); break }
        await responder.sendText(`♻️ Applying ${target} mode…`)
        const ok = await applyMode(target)
        await responder.sendText(
          ok
            ? target === "bypass"
              ? "✅ Bypass ON — tasks run without asking."
              : "🔐 Ask mode ON — permission requests arrive with Approve/Deny."
            : "⚠️ Server restart failed — try /move to the same directory.",
        )
        break
      }

      // --- move ---
      case "move": {
        if (args) {
          if (!fs.existsSync(args)) { await responder.sendText("⚠️ Directory does not exist."); break }
          await switchDir(args, responder)
          break
        }
        // no arg: show nearby folders as a NON-blocking list (a blocking picker
        // here would freeze the whole bot until tapped). You switch with /move <path>.
        const candidates = new Set<string>([DIRECTORY, path.dirname(DIRECTORY)])
        const scan = (root: string) => {
          try {
            for (const f of fs.readdirSync(root)) {
              const full = path.join(root, f)
              try {
                if (fs.statSync(full).isDirectory()) candidates.add(full)
              } catch { /* skip unreadable */ }
            }
          } catch { /* root not present */ }
        }
        scan(path.dirname(DIRECTORY)) // siblings of the current project
        scan(path.join(os.homedir(), "Desktop")) // real Desktop
        scan(os.homedir())
        const list = [...candidates].slice(0, 25)
        const lines = list.map((f) => `${f === DIRECTORY ? "📍 " : "• "}${f}`)
        await responder.sendText(
          `📂 Current project: ${DIRECTORY}\n\nTo switch, send:\n   /move <full path>\n\nNearby folders:\n${lines.join("\n")}`,
        )
        break
      }

      // --- remote / connection status ---
      case "remote": {
        const s = sid ? await opencode.client.session.get({ path: { id: sid } }).catch(() => null) : null
        const title = (s?.data as any)?.title || ""
        const modelStr =
          config.model === "auto"
            ? "🎬 auto (router)"
            : defaultModel
              ? `${defaultModel.providerID}/${defaultModel.modelID}`
              : "server default"
        const sessionLabel = sid ? `${title} (${sid.slice(0, 12)}…)` : "no active session"
        await responder.sendText(
          `✅ Connected\n📁 Directory: ${DIRECTORY}\n🤖 Model: ${modelStr}\n📋 Session: ${sessionLabel}`,
        )
        break
      }

      // --- learning loop (Phase D) ---
      case "recall": {
        if (!args) { await responder.sendText("Usage: /recall <keywords>"); break }
        // Refresh the FTS5 index from recent sessions, then run a ranked search.
        const list = await opencode.client.session.list({}).catch(() => null)
        const all: any[] = (list?.data as any[]) ?? []
        for (const s of all.slice(0, 30)) {
          const msgs = await opencode.client.session.messages({ path: { id: s.id } }).catch(() => null)
          const texts = ((msgs?.data as any[]) ?? [])
            .flatMap((m: any) => (m.parts ?? []).map((p: any) => p.text || ""))
            .join(" ")
          recall.put(s.id, String(s.title || ""), texts)
        }
        const hits = recall.search(args, 5)
        if (!hits.length) { await responder.sendText(`No past sessions match "${args}".`); break }
        const lines = hits.map((h) => `• ${h.title} (${h.sessionId.slice(0, 8)})\n  …${h.snippet}…`)
        await responder.sendText(`🔎 Recall "${args}":\n\n${lines.join("\n\n")}`)
        break
      }

      case "automemory": {
        const a = args.toLowerCase()
        if (a !== "on" && a !== "off") {
          await responder.sendText(
            `🧠 Auto-memory is ${autoMemory ? "ON — I save durable facts to AGENTS.md on my own" : "OFF"}\nUsage: /automemory on|off`,
          )
          break
        }
        autoMemory = a === "on"
        config.autoMemory = autoMemory
        saveGatewayConfig(config)
        await responder.sendText(autoMemory ? "🧠 Auto-memory ON — I'll remember on my own." : "🧠 Auto-memory OFF.")
        break
      }

      case "memory": {
        const a = args.trim()
        const readSafe = (f: string) => {
          try { return fs.readFileSync(f, "utf8") } catch { return "" }
        }
        if (a.toLowerCase().startsWith("search ")) {
          const q = a.slice(7).trim()
          const hits = memory.search([DIRECTORY, MEM_SCOPE_USER], q, 8)
          await responder.sendText(
            hits.length
              ? `🧠 Long-term memory matches for "${q}":\n${hits.map((h) => `- ${h.text}`).join("\n")}`
              : `No long-term memories match "${q}".`,
          )
          break
        }
        if (a.toLowerCase() === "curate") {
          await responder.sendText("🧠 Curating memory (merging duplicates, archiving overflow)…")
          await curateMemory()
        }
        const projWorking = sectionBullets(readSafe(path.join(DIRECTORY, "AGENTS.md")), "## Auto-memory").length
        const userWorking = sectionBullets(
          readSafe(path.join(os.homedir(), ".config", "opencode", "AGENTS.md")),
          USER_MEM_HEADER,
        ).length
        await responder.sendText(
          `🧠 Memory\n` +
            `  Working (always in context): project ${projWorking}/${WORKING_CAP_PROJECT} · user ${userWorking}/${WORKING_CAP_USER} bullets\n` +
            `  Long-term (out of context): ${memory.count(DIRECTORY)} project + ${memory.count(MEM_SCOPE_USER)} user facts\n` +
            `  Per message: the top-5 relevant long-term facts are injected automatically.\n\n` +
            `Usage: /memory · /memory search <keywords> · /memory curate`,
        )
        break
      }

      case "curate": {
        const archived = curateSkills()
        await responder.sendText(
          archived.length
            ? `🧹 Archived ${archived.length} unused skill(s): ${archived.join(", ")}\n(recoverable in skills/auto/_archived)`
            : "🧹 Nothing to archive — all auto-created skills are recent.",
        )
        break
      }

      case "profile": {
        const pf = path.join(os.homedir(), ".config", "opencode", "AGENTS.md")
        let content = ""
        try { content = fs.readFileSync(pf, "utf8") } catch { /* none yet */ }
        const m = content.match(/## About the user\s*([\s\S]*?)(?=\n## |\n# |$)/)
        const body = m ? m[1].trim() : ""
        await responder.sendText(
          body ? `👤 What I've learned about you:\n${body}` : "👤 No profile yet — chat with me and I'll learn who you are.",
        )
        break
      }

      case "remember": {
        if (!args) { await responder.sendText("Usage: /remember <fact to remember>"); break }
        try {
          const p = path.join(DIRECTORY, "AGENTS.md")
          let content = ""
          try { content = fs.readFileSync(p, "utf8") } catch { /* new file */ }
          const header = "## Memory (added via /remember)"
          if (!content.includes(header)) {
            content = content.trimEnd() + (content.trim() ? "\n\n" : "") + header + "\n"
          }
          content = content.trimEnd() + `\n- ${args}\n`
          fs.writeFileSync(p, content)
          memory.add(DIRECTORY, args) // long-term too, so retrieval can find it
          await responder.sendText(`🧠 Remembered in AGENTS.md:\n- ${args}`)
        } catch (err: any) {
          await responder.sendText(`⚠️ Could not write memory: ${err?.message ?? err}`)
        }
        break
      }

      // --- scheduled automations (Phase C) ---
      case "schedule": {
        if (!scheduler) { await responder.sendText("⚠️ Scheduler not available."); break }
        // Format: /schedule <cron expr> | <prompt>   e.g.  /schedule 0 9 * * * | summarize the git log
        const pipe = args.indexOf("|")
        if (pipe === -1) {
          await responder.sendText(
            "Usage: /schedule <cron> | <prompt>\n" +
              "Example: /schedule 0 9 * * * | summarize today's git log\n" +
              "(cron: min hour day month weekday)",
          )
          break
        }
        const cron = args.slice(0, pipe).trim()
        const prompt = args.slice(pipe + 1).trim()
        if (!cron || !prompt) { await responder.sendText("Both a cron expression and a prompt are required."); break }
        try {
          const job = scheduler.add({ cron, prompt, channelId, conversationId })
          await responder.sendText(`⏰ Scheduled job ${job.id}: "${prompt}"\nRuns: ${cron}\nRemove with /unschedule ${job.id}`)
        } catch (err: any) {
          await responder.sendText(`⚠️ Invalid cron expression: ${err?.message ?? err}`)
        }
        break
      }

      case "jobs": {
        if (!scheduler) { await responder.sendText("⚠️ Scheduler not available."); break }
        const jobs = scheduler.list().filter((j) => j.channelId === channelId && j.conversationId === conversationId)
        if (!jobs.length) { await responder.sendText("No scheduled jobs. Create one with /schedule."); break }
        const lines = jobs.map((j) => `• ${j.id} — "${j.prompt}" (${j.cron})`)
        await responder.sendText(`⏰ Scheduled jobs:\n${lines.join("\n")}\n\nRemove with /unschedule <id>`)
        break
      }

      case "unschedule": {
        if (!scheduler) { await responder.sendText("⚠️ Scheduler not available."); break }
        if (!args) { await responder.sendText("Usage: /unschedule <id>  (see /jobs)"); break }
        const ok = scheduler.remove(args.trim())
        await responder.sendText(ok ? `🗑️ Removed job ${args.trim()}.` : `No job with id ${args.trim()}.`)
        break
      }

      // --- native MCP tools (browser, etc.) ---
      case "tools":
      case "mcps": {
        const ids = Object.keys(MCP_CATALOG)
        const status = () =>
          ids
            .map((id) => `• ${id} — ${toolsEnabled[id] !== false ? "🟢 on" : "⚪ off"}\n  ${MCP_CATALOG[id]!.label}`)
            .join("\n")
        const parts = args.trim().split(/\s+/).filter(Boolean)
        if (parts.length === 0) {
          await responder.sendText(
            `🧰 Native tools (MCP):\n${status()}\n\nUsage: /tools <id> on|off  (e.g. /tools browser on)`,
          )
          break
        }
        const id = parts[0]!.toLowerCase()
        const arg = (parts[1] ?? "").toLowerCase()
        if (!MCP_CATALOG[id]) {
          await responder.sendText(`Unknown tool: ${id}\nAvailable: ${ids.join(", ")}`)
          break
        }
        if (arg !== "on" && arg !== "off") {
          await responder.sendText(`Usage: /tools ${id} on|off`)
          break
        }
        const next = arg === "on"
        if ((toolsEnabled[id] !== false) === next) { await responder.sendText(`${id} is already ${arg}.`); break }
        toolsEnabled[id] = next
        config.tools = { ...toolsEnabled }
        saveGatewayConfig(config)
        applyMcpConfig({ force: true })
        await responder.sendText(`♻️ Turning ${id} ${arg} — restarting server...`)
        try {
          server.close()
          server = await bootServer(DIRECTORY)
          opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
          opencodeV2 = createV2Client({ baseUrl: server.url })
          startEvents()
        } catch (err) {
          console.error("Restart failed:", err)
          await responder.sendText("⚠️ Server restart failed — restart the gateway.")
          break
        }
        let note = ""
        if (next) {
          const needsKey = MCP_CATALOG[id]!.needsKey
          if (needsKey && !process.env[needsKey]) {
            note = `\n⚠️ ${needsKey} is not set — set it in the environment for this tool to work.`
          } else if (id === "browser") {
            note = " First use may take a moment to download the browser."
          }
        }
        await responder.sendText(`✅ ${id} is now ${arg}.${note}`)
        break
      }

      // --- doctor ---
      case "doctor": {
        const home = os.homedir()
        const lines: string[] = ["🩺 Hollywood Code — install check\n"]

        // 1. hollycode.exe exists
        const exePath = path.join(home, ".hollycode", "hollycode.exe")
        const exeOk = fs.existsSync(exePath)
        lines.push(exeOk ? `✅ hollycode.exe found` : `⚠️ hollycode.exe missing at ~/.hollycode/hollycode.exe\n   Fix: re-run the installer`)

        // 2. launchers in ~/.bun/bin
        const bunBin = path.join(home, ".bun", "bin")
        const launcherNames = ["hollycode.cmd", "hollycode", "hollycode-remote.cmd", "hollycode-remote"]
        const foundLaunchers = launcherNames.filter((n) => fs.existsSync(path.join(bunBin, n)))
        const launcherOk = foundLaunchers.length > 0
        lines.push(launcherOk
          ? `✅ launchers: ${foundLaunchers.join(", ")}`
          : `⚠️ No launchers in ~/.bun/bin (hollycode.cmd / hollycode)\n   Fix: re-run install.ps1 or install.sh`)

        // 3. deps installed
        const depsPath = path.join(home, ".hollycode", "node_modules", "@opentui", "solid")
        const depsOk = fs.existsSync(depsPath)
        lines.push(depsOk ? `✅ node_modules OK` : `⚠️ Dependencies missing at ~/.hollycode/node_modules/@opentui/solid\n   Fix: cd ~/.hollycode && bun install`)

        // 4. gateway config has at least one channel with a token
        const channels = config.channels ?? []
        const hasToken = channels.some((ch: any) => ch.token && ch.token.length > 0)
        lines.push(hasToken ? `✅ gateway config has a channel token` : `⚠️ No channel token found in gateway config\n   Fix: add a telegram channel token to gateway.jsonc`)

        // 5. opencode auth present
        const authPaths = [
          path.join(home, ".local", "share", "opencode", "auth.json"),
          path.join(home, ".local", "share", "opencode", "account.json"),
          path.join(home, ".config", "opencode", "auth.json"),
          path.join(home, ".config", "opencode", "account.json"),
        ]
        const authOk = authPaths.some((p2) => fs.existsSync(p2))
        lines.push(authOk ? `✅ opencode auth found` : `⚠️ No auth.json / account.json found\n   Fix: run hollycode auth or log in via the TUI`)

        // 6. server reachable
        let serverOk = false
        try {
          const r = await opencode.client.config.providers()
          serverOk = !r.error
        } catch { /* unreachable */ }
        lines.push(serverOk ? `✅ server reachable` : `⚠️ Server not responding\n   Fix: /move to your project dir or restart the gateway`)

        await responder.sendText(lines.join("\n"))
        break
      }

      // --- rewind ---
      case "rewind": {
        if (!sid) { await responder.sendText("No active session."); break }
        const msgs = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
        if (!msgs?.data) { await responder.sendText("No messages in this session."); break }
        const userMsgs = (msgs.data as any[])
          .filter((m: any) => (m.role ?? m.info?.role) === "user")
          .reverse() // newest first
          .slice(0, 8)
        if (!userMsgs.length) { await responder.sendText("No user messages to rewind to."); break }
        const previews = userMsgs.map((m: any) => {
          const text: string =
            (m.parts as any[] | undefined)
              ?.filter((p: any) => p.type === "text")
              .map((p: any) => String(p.text || ""))
              .join(" ")
              .trim() || m.text || "(no text)"
          return text.slice(0, 55) + (text.length > 55 ? "…" : "")
        })
        const chosen = await responder.askQuestion({ question: "⏪ Rewind to which message?", options: previews })
        if (!chosen) break // cancelled / timed out
        const idx = previews.indexOf(chosen)
        if (idx < 0) break
        const target = userMsgs[idx]
        const messageID: string | undefined = target?.id ?? target?.info?.id
        if (!messageID) { await responder.sendText("⚠️ Could not identify message ID."); break }
        await opencode.client.session.revert({ path: { id: sid }, body: { messageID } }).catch(() => {})
        await responder.sendText(`⏪ Rewound to: "${chosen}"\nMessages after that point are now hidden. Use /redo to restore.`)
        break
      }

      // --- permissions ---
      case "permissions": {
        const cfgPath = path.join(DIRECTORY, "opencode.jsonc")
        const validActions = ["allow", "ask", "deny"] as const
        const validTools = ["bash", "edit", "write", "read", "webfetch", "external_directory"] as const
        type PermTool = typeof validTools[number]

        if (args) {
          const parts2 = args.trim().split(/\s+/)
          const tool = parts2[0]?.toLowerCase() as PermTool | undefined
          const action = parts2[1]?.toLowerCase() as typeof validActions[number] | undefined
          if (!tool || !validTools.includes(tool as PermTool)) {
            await responder.sendText(`Unknown tool. Valid tools: ${validTools.join(", ")}`)
            break
          }
          if (!action || !validActions.includes(action)) {
            await responder.sendText(`Unknown action. Valid: ${validActions.join(", ")}`)
            break
          }
          try {
            const raw = fs.existsSync(cfgPath) ? readJsonc(cfgPath) : { $schema: "https://opencode.ai/config.json" }
            if (!raw.permission || typeof raw.permission !== "object") raw.permission = {}
            raw.permission[tool] = action
            fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2))
            await responder.sendText(`✅ Permission set: ${tool} → ${action}\n⚠️ A server restart may be needed. Use /autoallow off|on to restart.`)
          } catch (err: any) {
            await responder.sendText(`⚠️ Could not update opencode.jsonc: ${err?.message ?? err}`)
          }
          break
        }
        // no args: show current permissions
        let perm: Record<string, string> = {}
        try {
          if (fs.existsSync(cfgPath)) {
            const raw = readJsonc(cfgPath)
            perm = (raw.permission ?? {}) as Record<string, string>
          }
        } catch { /* ignore */ }
        const rows = validTools.map((t) => `  ${t}: ${perm[t] ?? "(not set)"}`)
        await responder.sendText(
          `🔐 Tool permissions in ${cfgPath}:\n${rows.join("\n")}\n\nUsage: /permissions <tool> <allow|ask|deny>`,
        )
        break
      }

      // --- autocompact ---
      case "autocompact": {
        const cfgPath = path.join(DIRECTORY, "opencode.jsonc")
        const a = args.trim().toLowerCase()
        const readCompaction = (): Record<string, any> => {
          try {
            if (fs.existsSync(cfgPath)) {
              const raw = readJsonc(cfgPath)
              return (raw.compaction && typeof raw.compaction === "object" ? raw.compaction : {}) as Record<string, any>
            }
          } catch { /* ignore */ }
          return {}
        }
        const writeCompaction = (patch: Record<string, any>) => {
          const raw = fs.existsSync(cfgPath) ? readJsonc(cfgPath) : { $schema: "https://opencode.ai/config.json" }
          if (!raw.compaction || typeof raw.compaction !== "object") raw.compaction = {}
          Object.assign(raw.compaction, patch)
          fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2))
        }

        if (!a) {
          const c = readCompaction()
          const auto = c.auto === false ? "OFF" : "ON"
          const pct = typeof c.threshold_percent === "number" ? Math.round(c.threshold_percent * 100) : 95
          await responder.sendText(
            `🤏 Auto-compact is ${auto}\n  Threshold: ${pct}% of the model's context limit${typeof c.threshold_percent === "number" ? "" : " (default)"}\n\nUsage:\n  /autocompact <50-99>  set threshold %\n  /autocompact off|on   disable/enable`,
          )
          break
        }
        try {
          if (a === "off") {
            writeCompaction({ auto: false })
            await responder.sendText("🤏 Auto-compact disabled. Applying…")
            const ok = await reloadServer()
            await responder.sendText(ok ? "✅ Applied." : "⚠️ Saved, but reload failed — restart to apply.")
            break
          }
          if (a === "on") {
            writeCompaction({ auto: true })
            await responder.sendText("🤏 Auto-compact enabled. Applying…")
            const ok = await reloadServer()
            await responder.sendText(ok ? "✅ Applied." : "⚠️ Saved, but reload failed — restart to apply.")
            break
          }
          let n = Number(a)
          if (!Number.isFinite(n)) {
            await responder.sendText("Usage: /autocompact <50-99> | off | on")
            break
          }
          if (n > 1) n = n / 100 // accept 95 or 0.95
          if (n < 0.5 || n > 0.99) {
            await responder.sendText("Threshold must be between 50% and 99% (e.g. /autocompact 95).")
            break
          }
          writeCompaction({ auto: true, threshold_percent: n })
          await responder.sendText(`🤏 Auto-compact threshold set to ${Math.round(n * 100)}% of the context limit. Applying…`)
          const ok = await reloadServer()
          await responder.sendText(ok ? "✅ Applied — no restart needed." : "⚠️ Saved, but reload failed — restart to apply.")
        } catch (err: any) {
          await responder.sendText(`⚠️ Could not update opencode.jsonc: ${err?.message ?? err}`)
        }
        break
      }

      // --- context ---
      case "context": {
        if (!sid) { await responder.sendText("No active session."); break }
        const msgs = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
        if (!msgs?.data) { await responder.sendText("No messages yet."); break }

        const all = (msgs.data as any[]).map((m) => m.info ?? m)
        // Canonical context measure (mirrors opencode's sidebar/context.tsx): the LAST
        // assistant message with real output tokens — NOT the sum of every turn. Each
        // turn's `input` already IS the cumulative context window at that point, so
        // summing them inflates the number and it never drops after a /compact.
        const last = [...all].reverse().find((info) => info.role === "assistant" && (info.tokens?.output ?? 0) > 0)
        if (!last) { await responder.sendText("No assistant messages with token data yet."); break }
        const t = last.tokens ?? {}
        const isSummary = last.summary === true || last.mode === "compaction" || last.agent === "compaction"
        let totalInput: number
        let totalOutput: number
        if (isSummary) {
          // Right after /compact the last assistant IS the summary message: its large
          // `input` was a one-time read of the history being compacted. The forward
          // context the next turn will actually carry is the summary text (its output).
          totalInput = 0
          totalOutput = (t.output ?? 0) + (t.reasoning ?? 0)
        } else {
          totalInput = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          totalOutput = (t.output ?? 0) + (t.reasoning ?? 0)
        }
        const modelID: string | undefined = last.modelID
        const providerID: string | undefined = last.providerID
        const totalTokens = totalInput + totalOutput

        // Try to get the context limit from the model's metadata
        let contextLimit: number | undefined
        if (modelID || providerID) {
          try {
            const provRes = await opencode.client.config.providers()
            const providers: any[] = (provRes.data as any)?.providers ?? []
            const prov = providers.find((p: any) => p.id === providerID)
            const modelEntry = prov?.models?.[modelID ?? ""]
            contextLimit = modelEntry?.limit?.context
          } catch { /* best-effort */ }
        }

        const pct = contextLimit ? Math.round((totalTokens / contextLimit) * 100) : undefined
        const barLen = 20
        // Clamp filled segments to [0, barLen] — when usage exceeds the limit
        // (pct > 100) an unclamped count makes "░".repeat(negative) throw.
        const filled = pct != null ? Math.max(0, Math.min(barLen, Math.round((pct / 100) * barLen))) : 0
        const bar = pct != null ? "[" + "█".repeat(filled) + "░".repeat(barLen - filled) + "]" : ""

        const lines2 = [
          `📊 Context window — ${sid.slice(0, 12)}…`,
          `  Input tokens (incl. cache): ${totalInput.toLocaleString()}`,
          `  Output tokens (incl. reasoning): ${totalOutput.toLocaleString()}`,
          `  Total: ${totalTokens.toLocaleString()}`,
        ]
        if (contextLimit) {
          lines2.push(`  Limit: ${contextLimit.toLocaleString()}`)
          lines2.push(`  Used: ${pct}%  ${bar}`)
          if (pct! > 80) lines2.push(`\n⚠️ Context is getting full — consider /compact to save space.`)
        } else {
          lines2.push(`  (Context limit unavailable for this model — use /compact if sessions feel slow)`)
        }
        if (modelID) lines2.push(`  Model: ${providerID}/${modelID}`)
        await responder.sendText(lines2.join("\n"))
        break
      }

      // --- debug ---
      case "debug": {
        const a = args.toLowerCase()
        if (a !== "on" && a !== "off") {
          const logDir = path.join(os.homedir(), "AppData", "Local", "hollywood", "logs")
          await responder.sendText(
            `🐛 Debug logging is ${verbose ? "ON" : "OFF"}\nLog dir: ${logDir}\nUsage: /debug on|off`,
          )
          break
        }
        verbose = a === "on"
        config.debug = verbose
        saveGatewayConfig(config)
        await responder.sendText(verbose ? "🐛 Debug ON — verbose logging enabled." : "🐛 Debug OFF.")
        break
      }

      // --- goal ---
      case "goal": {
        const key = sessionKey(channelId, conversationId)
        const trimmed = args.trim()
        if (!trimmed) {
          const current = goalMap.get(key)
          await responder.sendText(
            current ? `🎯 Current goal:\n${current}\n\nClear with /goal off or /goal clear.` : "🎯 No goal set. Usage: /goal <condition>",
          )
          break
        }
        if (trimmed === "off" || trimmed === "clear") {
          goalMap.delete(key)
          await responder.sendText("🎯 Goal cleared.")
          break
        }
        goalMap.set(key, trimmed)
        await responder.sendText(`🎯 Goal set:\n${trimmed}\n\nI'll keep working until this is fully met. Clear with /goal off.`)
        break
      }

      // --- loop ---
      case "loop": {
        const key = sessionKey(channelId, conversationId)
        const trimmed = args.trim()
        if (!trimmed) {
          const active = loopMap.has(key)
          await responder.sendText(
            active
              ? "🔁 Loop is running. Stop with /loop stop.\nUsage: /loop <seconds> | <prompt>"
              : "🔁 No loop active.\nUsage: /loop <seconds> | <prompt>\nExample: /loop 60 | summarize new git commits",
          )
          break
        }
        if (trimmed === "stop" || trimmed === "off") {
          const existing = loopMap.get(key)
          if (existing) { clearInterval(existing); loopMap.delete(key) }
          await responder.sendText("🔁 Loop stopped.")
          break
        }
        const pipe = trimmed.indexOf("|")
        if (pipe === -1) {
          await responder.sendText("Usage: /loop <seconds> | <prompt>\nExample: /loop 60 | check build status")
          break
        }
        const rawSec = parseInt(trimmed.slice(0, pipe).trim(), 10)
        const loopPrompt = trimmed.slice(pipe + 1).trim()
        if (!loopPrompt) { await responder.sendText("A prompt is required after the |."); break }
        const seconds = isNaN(rawSec) || rawSec < 30 ? 30 : rawSec
        // Clear any existing loop for this conversation.
        const oldInterval = loopMap.get(key)
        if (oldInterval) { clearInterval(oldInterval); loopMap.delete(key) }
        // Overlap guard: a prompt slower than the interval used to stack
        // concurrent runs against the same session. Skip ticks while running.
        let loopBusy = false
        const handle = setInterval(async () => {
          if (loopBusy) { log("loop", `tick skipped for ${key} — previous run still in flight`); return }
          loopBusy = true
          try {
            const out = await runPrompt(channelId, conversationId, loopPrompt)
            if (deliver) await deliver(channelId, conversationId, out)
          } catch (err: any) {
            log("loop", `Error in loop for ${key}: ${err?.message ?? err}`)
          } finally {
            loopBusy = false
          }
        }, seconds * 1000)
        loopMap.set(key, handle)
        await responder.sendText(
          `🔁 Loop started — running every ${seconds}s:\n"${loopPrompt}"\n\nStop with /loop stop.`,
        )
        break
      }

      // --- CLI-only stubs ---
      case "diff":
      case "editor":
      case "exit":
      case "themes":
      case "timeline":
      case "timestamps":
      case "stuntdouble":
      case "connect": {
        await responder.sendText(`⚠️ /${command} is a CLI-only command.`)
        break
      }

      default: {
        await responder.sendText(`Unknown command: /${command}`)
        break
      }
    }
  }

  // ---------------------------------------------------------------------------
  // isAuthorized
  // ---------------------------------------------------------------------------

  const isAuthorized = (channelId: string, userId: string): boolean => {
    const ch = channel(config, channelId)
    if (!ch) return false
    if (!ch.allowedIds.length) return false
    return ch.allowedIds.includes(userId)
  }

  // ---------------------------------------------------------------------------
  // GatewayContext
  // ---------------------------------------------------------------------------

  // Phase B: optional voice transcription + TTS, configured via config.voice.
  // Transcription works with an API key OR free local whisper.cpp (if bundled).
  const transcriber =
    config.voice && (config.voice.apiKey || localSttAvailable(config.voice))
      ? createTranscriber(config.voice)
      : localSttAvailable()
        ? createTranscriber({})
        : undefined
  // Speaker works even without an API key (free local Piper TTS).
  let speaker = config.voice ? createSpeaker(config.voice) : undefined
  let speakAlways = config.voice?.speakReplies ?? false
  if (transcriber || speaker) log("engine", `Voice: ${transcriber ? "transcription " : ""}${speaker ? "TTS" : ""}`)

  const context: GatewayContext = {
    isAuthorized,
    handleMessage,
    handleCommand,
    log,
    ...(transcriber
      ? { transcribe: (audio: Uint8Array, filename: string) => transcriber.transcribe(audio, filename) }
      : {}),
    ...(speaker ? { speak: (text: string) => speaker!.synthesize(text) } : {}),
  }

  // stop() kills the server process
  const stop = () => {
    clearInterval(reconciler)
    clearInterval(curatorTimer)
    clearInterval(cronInboxTimer)
    // Clear all active /loop intervals.
    for (const handle of loopMap.values()) clearInterval(handle)
    loopMap.clear()
    clearTimeout(memoryBootTimer)
    recall.close()
    memory.close()
    eventAbort.abort()
    if (serverProc) {
      serverProc.kill()
      serverProc = undefined
    }
    server.close()
  }

  const setScheduler = (s: SchedulerHandle) => {
    scheduler = s
  }

  const setDeliver = (d: (channelId: string, conversationId: string, text: string) => Promise<void>) => {
    deliver = d
  }

  const setDeliverVoice = (d: (channelId: string, conversationId: string, audio: Uint8Array) => Promise<void>) => {
    deliverVoice = d
  }

  const setDeliverImage = (
    d: (channelId: string, conversationId: string, data: Uint8Array, filename: string, caption?: string) => Promise<void>,
  ) => {
    deliverImage = d
  }

  return { context, stop, runPrompt, setScheduler, setDeliver, setDeliverVoice, setDeliverImage }
}
