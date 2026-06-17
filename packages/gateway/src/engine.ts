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

  // --- Permission mode ------------------------------------------------------
  let autoAllow = config.autoAllow ?? false
  const permissionBlock = () =>
    autoAllow
      ? { external_directory: "allow", bash: "allow", read: "allow", write: "allow", edit: "allow", webfetch: "allow" }
      : { external_directory: "ask", bash: "ask", read: "allow", write: "ask", edit: "ask", webfetch: "allow" }

  const applyPermissionMode = () => {
    try {
      const p = path.join(DIRECTORY, "opencode.jsonc")
      const raw = fs.existsSync(p) ? readJsonc(p) : { $schema: "https://opencode.ai/config.json" }
      raw.permission = permissionBlock()
      fs.writeFileSync(p, JSON.stringify(raw, null, 2))
      log("engine", `Permission mode: ${autoAllow ? "auto-allow" : "ask via channel"}`)
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

  const applyMcpConfig = () => {
    try {
      const p = path.join(DIRECTORY, "opencode.jsonc")
      const raw = fs.existsSync(p) ? readJsonc(p) : { $schema: "https://opencode.ai/config.json" }
      const mcp: Record<string, unknown> = {}
      for (const [id, def] of Object.entries(MCP_CATALOG)) {
        mcp[id] = { type: def.type, command: def.command, enabled: toolsEnabled[id] !== false }
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
  const startEvents = () => {
    eventAbort.abort()
    eventAbort = new AbortController()
    const sig = eventAbort.signal
    void (async () => {
      const events = await opencode.client.event.subscribe()
      for await (const event of events.stream) {
        if (sig.aborted) break
        if (event.type !== "message.part.updated") continue
        const part = event.properties.part as ToolPart
        if (part.type !== "tool" || part.state.status !== "completed") continue
        const handle = statusHandles.get(part.sessionID)
        if (!handle) continue
        const lines = statusLines.get(part.sessionID) ?? []
        lines.push(`✓ ${part.tool} — ${part.state.title}`)
        statusLines.set(part.sessionID, lines)
        const text = "🎬 working...\n" + lines.slice(-8).join("\n")
        await handle.update(text).catch(() => {})
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

  const resolvePending = async (sid: string, responder: Responder, autoAllowFlag: boolean) => {
    // v1 global permissions
    const globalPerms = await opencodeV2.permission.list({}).catch(() => null)
    const v1Requests: any[] = (globalPerms?.data as any) ?? []
    for (const r of v1Requests) {
      if (r.sessionID !== sid) continue
      if (autoAllowFlag) {
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
      if (autoAllowFlag) {
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
      if (autoAllowFlag || !first?.options?.length) {
        const answers: string[][] =
          q.questions?.map((qq: any) => (qq.options?.[0]?.label ? [qq.options[0].label] : ["ok"])) ?? []
        await opencodeV2.v2.session.question
          .reply({ sessionID: q.sessionID, requestID: q.id, questionV2Reply: { answers } })
          .catch(() => {})
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
          return opencodeV2.v2.session.question
            .reply({ sessionID: q.sessionID, requestID: q.id, questionV2Reply: { answers } })
            .catch(() => {})
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
      await opencodeV2.v2.session.question.reply({ sessionID: q.sessionID, requestID: q.id, questionV2Reply: { answers } }).catch(() => {})
    }
  }

  // Global safety-net reconciler: every few seconds, deliver any pending
  // permission/question to the LAST responder of each active conversation.
  // This decouples delivery from a single prompt()'s lifecycle — so buttons
  // reliably arrive even when prompt() returns while a question/permission is
  // still pending (which used to freeze the session and force /new).
  const reconciler = setInterval(() => {
    for (const [sid, responder] of activeResponders) {
      void resolvePending(sid, responder, autoAllow)
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
  // Runs every 6h while idle (config.skillCurator !== false).
  const curatorTimer = setInterval(() => {
    if (config.skillCurator !== false) curateSkills()
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
  const promptWithFallback = async (
    sessionId: string,
    parts: any[],
    model: { providerID: string; modelID: string } | undefined,
  ): Promise<{ result: any; fellBackTo?: string }> => {
    const run = (m?: { providerID: string; modelID: string }) => {
      const body: any = { parts }
      if (m) body.model = m
      return opencode.client.session
        .prompt({ path: { id: sessionId }, body })
        .catch((err: any) => ({ error: err, data: undefined }))
    }
    const fb = freeModel
    const isPinnedPaid =
      !!model && (!fb || model.providerID !== fb.providerID || model.modelID !== fb.modelID)

    // A pinned (likely paid) model with no credits doesn't fail fast — the SDK
    // retries the quota error for minutes, which would freeze the bot. Race it
    // against a timeout; if it stalls, abort the server-side run and fall back.
    const PINNED_TIMEOUT_MS = 45_000
    const runFirst = async () => {
      if (!isPinnedPaid) return run(model)
      const TIMEOUT = Symbol("timeout")
      const raced = await Promise.race([
        run(model),
        new Promise<typeof TIMEOUT>((res) => setTimeout(() => res(TIMEOUT), PINNED_TIMEOUT_MS)),
      ])
      if (raced === TIMEOUT) {
        log("engine", `model ${model!.providerID}/${model!.modelID} stalled >${PINNED_TIMEOUT_MS}ms — aborting & falling back`)
        await opencode.client.session.abort({ path: { id: sessionId } }).catch(() => {})
        return { error: new Error("model timed out"), data: undefined }
      }
      return raced
    }

    const result = await runFirst()
    if (!promptFailed(result)) return { result }
    if (!fb || !isPinnedPaid) return { result } // already on the free model (or none) — nothing better to try
    log("engine", `prompt failed on ${model?.providerID}/${model?.modelID} — falling back to ${fb.providerID}/${fb.modelID}`)
    const retry = await run(fb)
    if (!promptFailed(retry)) return { result: retry, fellBackTo: `${fb.providerID}/${fb.modelID}` }
    return { result } // both failed → surface the original failure
  }

  // ---------------------------------------------------------------------------
  // handleMessage
  // ---------------------------------------------------------------------------

  const handleMessage = async (channelId: string, msg: { conversationId: string; userId: string; text: string }, responder: Responder) => {
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

    await resolvePending(sessionId, responder, autoAllow)

    const flavor = PERSONALITIES[personality]
    const goal = goalMap.get(sessionKey(channelId, msg.conversationId))
    let promptText = flavor ? `[Personality: ${flavor}]\n\n${msg.text}` : msg.text
    if (goal) promptText = `[Goal: ${goal} — keep working until this is fully met; do not stop early.]\n\n${promptText}`
    const pinnedModel = config.model !== "auto" ? defaultModel : undefined
    if (verbose) log("engine", `handleMessage: goal=${goal ?? "none"} flavor=${personality}`)
    log("engine", `handleMessage: "${msg.text.slice(0, 40)}" model=${pinnedModel ? `${pinnedModel.providerID}/${pinnedModel.modelID}` : "auto"} → prompting...`)

    const poller = setInterval(() => { void resolvePending(sessionId, responder, autoAllow) }, 3000)
    const { result, fellBackTo } = await promptWithFallback(
      sessionId,
      [{ type: "text", text: promptText }],
      pinnedModel,
    )
    clearInterval(poller)
    log("engine", `handleMessage: prompt returned (fellBackTo=${fellBackTo ?? "no"}, hasData=${!!result.data}, err=${!!(result as any).error})`)
    await resolvePending(sessionId, responder, autoAllow)

    statusHandles.delete(sessionId)
    statusLines.delete(sessionId)

    if ((result as any).error || !result.data) {
      console.error("Prompt failed:", (result as any).error)
      await statusHandle.finalize("⚠️ error").catch(() => {})
      await responder.sendText("⚠️ Something went wrong. Try again or /new.")
      return
    }

    const data = result.data as any
    const info = data.info as { modelID?: string; providerID?: string } | undefined
    const parts = data.parts as Array<{ type: string; text?: string }> | undefined

    const reply =
      parts
        ?.filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
        .trim() || ""

    const modelLabel = info?.modelID ? `🎬 ${info.providerID}/${info.modelID}` : "🎬 done"

    if (reply) {
      await statusHandle.finalize(modelLabel).catch(() => {})
      if (fellBackTo) {
        await responder
          .sendText(
            `⚠️ Your selected model failed (likely out of credits or rate-limited) — ` +
              `I answered with the free ${fellBackTo} instead.\nPin another anytime with /model.`,
          )
          .catch(() => {})
      }
      await responder.sendText(reply)
      // Voice loop: speak the reply back when the user sent audio, or always if
      // /voice is on (free local Piper TTS — no transcription needed for this).
      if (((msg as any).audio || speakAlways) && speaker && responder.sendVoice) {
        try {
          const audio = await speaker.synthesize(reply)
          await responder.sendVoice(audio)
        } catch (err: any) {
          log("voice", `TTS reply failed: ${err?.message ?? err}`)
        }
      }
      // Silent auto-memory curation (background, non-blocking).
      void reviewAndRemember(channelId, msg.conversationId, msg.text, reply)
    } else {
      const errorPart = parts?.find((p) => p.type === "retry")
      const errorMsg = errorPart ? `⚠️ ${(errorPart as any).error?.data?.message || "Error"}` : "⚠️ No text response"
      await statusHandle.finalize(`${modelLabel}\n${errorMsg}`).catch(() => {})
    }
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

      // Append new bullets under a header in a file, deduped.
      const appendBullets = (file: string, header: string, bullets: string[], label: string) => {
        if (!bullets.length) return
        let content = ""
        try { content = fs.readFileSync(file, "utf8") } catch { /* new file */ }
        if (!content.includes(header)) content = content.trimEnd() + (content.trim() ? "\n\n" : "") + header + "\n"
        let added = 0
        for (const b of bullets) {
          if (!content.includes(b)) { content = content.trimEnd() + `\n- ${b}\n`; added++ }
        }
        if (added) {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, content)
          log("memory", `auto-saved ${added} ${label} fact(s)`)
        }
      }

      // Project facts → project AGENTS.md; user profile → global AGENTS.md.
      appendBullets(path.join(DIRECTORY, "AGENTS.md"), "## Auto-memory", bulletsOf(projM?.[1]), "project")
      appendBullets(
        path.join(os.homedir(), ".config", "opencode", "AGENTS.md"),
        "## About the user",
        bulletsOf(userM?.[1]),
        "user-profile",
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
      await opencodeV2.v2.session.question.reply({ sessionID: q.sessionID, requestID: q.id, questionV2Reply: { answers } }).catch(() => {})
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
            "/move — change project dir\n/thinking — toggle thinking\n/remote — connection status\n" +
            "/autoallow — on: approve everything · off: ask here\n" +
            "/schedule <cron> | <prompt> — run a task on a schedule\n/jobs — list scheduled · /unschedule <id>\n" +
            "/recall <keywords> — search past sessions\n/remember <fact> — save to AGENTS.md memory\n" +
            "/automemory on|off — agent curates memory automatically\n" +
            "/personality <name> — set agent personality\n/insights [days] — usage insights\n/compress — compact context\n" +
            "/voice on|off — speak replies aloud (free local Piper)\n" +
            "/profile — what I've learned about you\n/curate — archive unused auto-skills\n" +
            "/tools — enable/disable native tools (browser, …)\n" +
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
        saveStore()
        await responder.sendText("🆕 New session. Send your next message to begin.")
        break
      }

      case "status": {
        if (!sid) { await responder.sendText("No active session."); break }
        const s = await opencode.client.session.get({ path: { id: sid } }).catch(() => null)
        const m = s?.data ? `${(s.data as any).title} (${sid.slice(0, 12)}…)` : sid
        await responder.sendText(`📁 ${m}\n📂 ${DIRECTORY}`)
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
        const f = await opencode.client.session.fork({ path: { id: sid }, body: { title: name } as any }).catch(() => null)
        if (!f?.data) { await responder.sendText("⚠️ Fork failed."); break }
        const key = sessionKey(channelId, conversationId)
        sessionMap.set(key, (f.data as any).id)
        saveStore()
        await responder.sendText(`🔀 Forked. New session: ${(f.data as any).id}`)
        break
      }

      case "undo": {
        if (!sid) { await responder.sendText("No active session."); break }
        await opencode.client.session.revert({ path: { id: sid } }).catch(() => {})
        await responder.sendText("↩️ Undone last message.")
        break
      }

      case "compact":
      case "compress": {
        if (!sid) { await responder.sendText("No active session."); break }
        await opencodeV2.v2.session.compact({ sessionID: sid }).catch(() => {})
        await responder.sendText("📦 Session compacted.")
        break
      }

      case "voice": {
        const a = args.toLowerCase()
        if (a !== "on" && a !== "off") {
          await responder.sendText(
            `🔊 Speak-replies is ${speakAlways ? "ON" : "OFF"}\nUsage: /voice on|off (free local Piper TTS — speaks every reply)`,
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
        const recent = all.filter((s: any) => (s.time?.updated ?? s.time?.created ?? 0) >= since || true).slice(0, 50)
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
      case "sessions":
      case "s": {
        if (args) {
          const key = sessionKey(channelId, conversationId)
          sessionMap.delete(key)
          sessionMap.set(key, args)
          saveStore()
          await responder.sendText(`✅ Switched to session: ${args}`)
          break
        }
        const list = await opencode.client.session.list({}).catch(() => null)
        if (!list?.data) { await responder.sendText("No sessions found."); break }
        const all: any[] = list.data as any[]
        const options = all.slice(0, 20).map((s: any) =>
          `${s.id === sid ? "👉 " : ""}${s.title || "untitled"} (${s.id.slice(0, 8)})`,
        )
        if (!options.length) { await responder.sendText("No sessions found."); break }
        const chosen = await responder.askQuestion({ question: "📋 Sessions — choose to switch:", options })
        // find id from chosen label (matches the "(8-char-id)" suffix)
        const match = chosen.match(/\(([a-f0-9-]{8})\)$/)
        if (match) {
          const partial = match[1]!
          const target = (all as any[]).find((s: any) => s.id.startsWith(partial))
          if (target) {
            const key = sessionKey(channelId, conversationId)
            sessionMap.delete(key)
            sessionMap.set(key, target.id)
            saveStore()
            await responder.sendText(`✅ Switched to: ${target.title || target.id}`)
          }
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
        const lines = (msgs.data as any[]).map(
          (m: any) => `[${m.role}]\n${m.parts?.map((p: any) => p.text || "").join("\n") || ""}`,
        )
        await responder.sendText(lines.join("\n\n") || "(empty transcript)")
        break
      }

      // --- agents / skills ---
      case "agents": {
        const list = await opencodeV2.v2.agent.list({}).catch(() => null)
        const agents: any[] = (list?.data as any)?.data
        if (!agents?.length) { await responder.sendText("No agents available."); break }
        const rows = agents.map((a: any) => `${a.id} — ${a.name || a.id}`)
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
        await opencode.client.session.init({ path: { id: sid }, body: { directory: DIRECTORY } as any }).catch(() => {})
        await responder.sendText("📝 Session initialized with AGENTS.md.")
        break
      }

      case "share": {
        if (!sid) { await responder.sendText("No active session."); break }
        const res = await opencode.client.session.share({ path: { id: sid } }).catch(() => null)
        if (!res?.data) { await responder.sendText("⚠️ Share failed."); break }
        await responder.sendText(`🔗 Shared: ${(res.data as any).url || (res.data as any).id}`)
        break
      }

      case "review": {
        if (!sid) { await responder.sendText("No active session."); break }
        const diff = await opencode.client.session.diff({ path: { id: sid } }).catch(() => null)
        if (!diff?.data) { await responder.sendText("No changes to review."); break }
        await responder.sendText((diff.data as any).diff || JSON.stringify(diff.data, null, 2))
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

      // --- variants ---
      case "variants": {
        // List models via the v2 API, find the current model, and show its variants.
        const modelRes = await opencodeV2.v2.model.list().catch(() => null)
        const allModels: any[] = (modelRes?.data as any) ?? []
        const curModel = defaultModel
        const modelEntry = curModel
          ? allModels.find(
              (m: any) =>
                m.id === curModel.modelID ||
                (m.providerID === curModel.providerID && (m.id === curModel.modelID || m.modelID === curModel.modelID)),
            )
          : undefined
        const variants: Array<{ id: string }> = modelEntry?.variants ?? []
        if (!variants.length) {
          await responder.sendText(
            `ℹ️ No variants available for ${curModel ? `${curModel.providerID}/${curModel.modelID}` : "the current model"}.`,
          )
          break
        }
        const options = variants.map((v: any) => String(v.id))
        const chosen = await responder.askQuestion({ question: "🎞️ Pick a model variant:", options })
        if (!chosen) break // timed out / cancelled
        try {
          const p = path.join(DIRECTORY, "opencode.jsonc")
          const raw = fs.existsSync(p) ? readJsonc(p) : { $schema: "https://opencode.ai/config.json" }
          if (typeof raw.model === "object" && raw.model !== null) {
            raw.model.variant = chosen
          } else {
            raw.model = { id: curModel?.modelID, providerID: curModel?.providerID, variant: chosen }
          }
          fs.writeFileSync(p, JSON.stringify(raw, null, 2))
        } catch { /* best-effort */ }
        await responder.sendText(`✅ Variant set to: ${chosen}`)
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
          await responder.sendText(`ℹ️ Only one organization available: ${orgs[0]?.name ?? orgs[0]?.orgID ?? orgs[0]?.id}. Nothing to switch.`)
          break
        }
        const options = orgs.map((o: any) => String(o.name ?? o.orgID ?? o.id ?? "(unknown)"))
        const chosen = await responder.askQuestion({ question: "🏢 Pick an organization:", options })
        if (!chosen) break // timed out / cancelled
        const idx = options.indexOf(chosen)
        const target = orgs[idx]
        if (!target) break
        await opencodeV2.experimental.console.switchOrg({ accountID: target.accountID, orgID: target.orgID ?? target.id }).catch(() => {})
        await responder.sendText(`✅ Switched to org: ${chosen}`)
        break
      }

      // --- model ---
      case "model": {
        if (args === "auto") {
          config.model = "auto"
          saveGatewayConfig(config)
          try {
            const p = path.join(DIRECTORY, "opencode.jsonc")
            const raw = readJsonc(p)
            delete raw.model
            fs.writeFileSync(p, JSON.stringify(raw, null, 2))
          } catch { /* best-effort */ }
          await responder.sendText(
            "🎬 AUTO mode — the Hollywood router now casts each message:\n" +
              "cheap chat → stunt double, hard tasks → the star.\n" +
              "Each reply is labeled with the model that played.\n" +
              "Pin again anytime with /model providerID/modelID",
          )
          break
        }
        if (args) {
          const parts = args.split("/")
          if (parts.length < 2) { await responder.sendText("Invalid format. Use: /model providerID/modelID (or /model auto)"); break }
          defaultModel = { providerID: parts[0]!, modelID: parts.slice(1).join("/") }
          config.model = args
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
            ? "🎬 auto (Hollywood router casts per message)"
            : defaultModel
              ? `${defaultModel.providerID}/${defaultModel.modelID}`
              : "server default"

        // step 1 — provider (plus an AUTO shortcut)
        const AUTO_LABEL = "🎬 auto (router)"
        log("engine", `/model: provider step (providers: ${providers.map((p: any) => p.id).join(", ")})`)
        const provChoice = await responder.askQuestion({
          question: `🤖 Current: ${cur}\n\nPick a provider:`,
          options: [AUTO_LABEL, ...providers.map((p: any) => String(p.id))],
        })
        log("engine", `/model: provider chosen = "${provChoice}"`)
        if (!provChoice) break // timed out / cancelled
        if (provChoice === AUTO_LABEL) {
          config.model = "auto"
          saveGatewayConfig(config)
          try {
            const p = path.join(DIRECTORY, "opencode.jsonc")
            const raw = readJsonc(p)
            delete raw.model
            fs.writeFileSync(p, JSON.stringify(raw, null, 2))
          } catch { /* best-effort */ }
          await responder.sendText("🎬 AUTO mode — the router casts each message (free unless a task needs more).")
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
        saveGatewayConfig(config)
        await opencode.client.config.update({ body: { model: chosen } as any }).catch(() => {})
        syncModelToFile(chosen)
        await responder.sendText(`✅ Model set to ${chosen}`)
        log("engine", `/model: set to ${chosen}`)
        break
      }

      // --- thinking ---
      case "thinking": {
        if (!sid) { await responder.sendText("No active session."); break }
        if (args) {
          await opencode.client.session.update({ path: { id: sid }, body: { thinking: args } as any }).catch(() => {})
          await responder.sendText(`🧠 Thinking set to: ${args}`)
          break
        }
        const s = await opencode.client.session.get({ path: { id: sid } }).catch(() => null)
        const current = (s?.data as any)?.thinking || "default"
        await responder.sendText(`🧠 Current thinking: ${current}\nUsage: /thinking on|off|auto`)
        break
      }

      // --- autoallow ---
      case "autoallow": {
        const arg = args.toLowerCase()
        if (arg !== "on" && arg !== "off") {
          await responder.sendText(
            `🔐 Auto-allow is ${autoAllow ? "ON — everything approved automatically" : "OFF — approvals come here"}\nUsage: /autoallow on|off`,
          )
          break
        }
        const next = arg === "on"
        if (next === autoAllow) { await responder.sendText(`Already ${arg}.`); break }
        autoAllow = next
        config.autoAllow = autoAllow
        saveGatewayConfig(config)
        applyPermissionMode()
        await responder.sendText(`♻️ Applying ${autoAllow ? "auto-allow" : "ask"} mode — restarting server...`)
        try {
          server.close()
          server = await bootServer(DIRECTORY)
          opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
          opencodeV2 = createV2Client({ baseUrl: server.url })
          startEvents()
        } catch (err) {
          console.error("Restart failed:", err)
          await responder.sendText("⚠️ Server restart failed — try /move to the same directory or restart.")
          break
        }
        await responder.sendText(
          autoAllow
            ? "✅ Auto-allow ON — tasks run without asking."
            : "🔐 Ask mode ON — permission requests will arrive with Approve/Deny options.",
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
        applyMcpConfig()
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

      // --- context ---
      case "context": {
        if (!sid) { await responder.sendText("No active session."); break }
        const msgs = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
        if (!msgs?.data) { await responder.sendText("No messages yet."); break }

        let totalInput = 0
        let totalOutput = 0
        let modelID: string | undefined
        let providerID: string | undefined
        for (const m of msgs.data as any[]) {
          const info = m.info ?? m
          if (info.role !== "assistant") continue
          const t = info.tokens ?? {}
          totalInput += (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          totalOutput += (t.output ?? 0) + (t.reasoning ?? 0)
          if (info.modelID) { modelID = info.modelID; providerID = info.providerID }
        }
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
        const handle = setInterval(async () => {
          try {
            const out = await runPrompt(channelId, conversationId, loopPrompt)
            if (deliver) await deliver(channelId, conversationId, out)
          } catch (err: any) {
            log("loop", `Error in loop for ${key}: ${err?.message ?? err}`)
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
    recall.close()
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

  return { context, stop, runPrompt, setScheduler, setDeliver, setDeliverVoice }
}
