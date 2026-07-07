import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { SchedulerHandle } from "./scheduler"
import type { RecallIndex } from "./search"

// Cross-process bridge so the AGENT (running inside the opencode server child
// process) can use gateway-only capabilities when asked in natural language —
// schedule recurring tasks, search past sessions, and send a proactive message
// to the current chat. Mirrors how Hermes exposes these as agent tools over its
// internal services.
//
// Mechanism: each agent tool is installed into opencode's global tool dir. A
// tool writes a request file into an inbox; the gateway watches the inbox,
// resolves which chat the requesting session belongs to, performs the op, and
// writes a response the tool reads back. (The `memory` tool is self-contained —
// it edits AGENTS.md directly — so it also works in the TUI, no gateway needed.)

const BASE = path.join(os.homedir(), ".config", "hollywood", "agent-cron")
const IN_DIR = path.join(BASE, "in")
const OUT_DIR = path.join(BASE, "out")
// opencode loads custom tools from tool/ under its global config dir (verified:
// ConfigPaths.directories lists the global dir first), visible to every session.
const TOOL_DIR = path.join(os.homedir(), ".config", "opencode", "tool")

interface AgentRequest {
  id: string
  sessionID: string
  kind?: string // "cron" (default) | "recall" | "send_message"
  // cron
  action?: string
  schedule?: string
  prompt?: string
  job_id?: string
  // recall
  query?: string
  // send_message
  text?: string
}

// ── Tool sources (written to disk; node builtins only so they resolve anywhere) ──

const CRONJOB_SOURCE = `import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"

const BASE = path.join(os.homedir(), ".config", "hollywood", "agent-cron")

export default {
  description:
    "Schedule the agent to run a task automatically on a cron schedule and deliver the result back to THIS chat. " +
    "Use when the user asks to be pinged/reminded/updated on a schedule, or wants a recurring 'heartbeat'. " +
    "action='create' needs schedule (cron) + prompt; action='list' shows this chat's jobs; action='remove' needs job_id. " +
    "Cron format is 'min hour day month weekday' (e.g. '0 9 * * *' = 9am daily, '*/10 * * * *' = every 10 minutes). " +
    "For a quiet heartbeat/watchdog that only messages when something is worth reporting, make the prompt instruct the agent to reply with exactly 'NOOP' when there is nothing to say — NOOP replies are not delivered. " +
    "Pass an empty string for fields that do not apply.",
  args: {
    action: { type: "string", enum: ["create", "list", "remove"], description: "create, list, or remove a scheduled job." },
    schedule: { type: "string", description: "Cron expression for create, e.g. '0 9 * * *'. Empty for list/remove." },
    prompt: { type: "string", description: "What to do on each run, in natural language. Empty for list/remove." },
    job_id: { type: "string", description: "Job id to remove (from action='list'). Empty for create/list." },
  },
  async execute(args: any, ctx: any) {
    return await __bridge("cron", { action: String(args.action || ""), schedule: String(args.schedule || ""), prompt: String(args.prompt || ""), job_id: String(args.job_id || "") }, ctx)
  },
}

async function __bridge(kind: string, payload: any, ctx: any) {
  const id = crypto.randomUUID()
  const inDir = path.join(BASE, "in"), outDir = path.join(BASE, "out")
  fs.mkdirSync(inDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
  // Only the remote-control gateway watches this inbox. If it isn't live (e.g. in
  // the plain terminal/TUI), don't hang — say so immediately.
  try { const a = path.join(BASE, "gateway.alive"); if (!fs.existsSync(a) || Date.now() - fs.statSync(a).mtimeMs > 8000) return "This tool works through Hollycode's remote-control gateway (e.g. Telegram), not in the plain terminal here." } catch {}
  fs.writeFileSync(path.join(inDir, id + ".json"), JSON.stringify({ id, kind, sessionID: ctx && ctx.sessionID ? ctx.sessionID : "", ...payload }))
  const outPath = path.join(outDir, id + ".json")
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400))
    if (fs.existsSync(outPath)) {
      try { const res = JSON.parse(fs.readFileSync(outPath, "utf8")); try { fs.unlinkSync(outPath) } catch {} ; return (res.ok ? "OK: " : "Error: ") + res.message } catch { break }
    }
  }
  return "Request was queued (no confirmation yet)."
}
`

const RECALL_SOURCE = `import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"

const BASE = path.join(os.homedir(), ".config", "hollywood", "agent-cron")

export default {
  description:
    "Search the user's PAST sessions/conversations by keyword (full-text). Use when the user refers to something discussed before ('what did we decide about X', 'find that earlier thing'). Returns ranked snippets from prior sessions.",
  args: {
    query: { type: "string", description: "Keywords to search for across past sessions." },
  },
  async execute(args: any, ctx: any) {
    return await __bridge("recall", { query: String(args.query || "") }, ctx)
  },
}

async function __bridge(kind: string, payload: any, ctx: any) {
  const id = crypto.randomUUID()
  const inDir = path.join(BASE, "in"), outDir = path.join(BASE, "out")
  fs.mkdirSync(inDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
  // Only the remote-control gateway watches this inbox. If it isn't live (e.g. in
  // the plain terminal/TUI), don't hang — say so immediately.
  try { const a = path.join(BASE, "gateway.alive"); if (!fs.existsSync(a) || Date.now() - fs.statSync(a).mtimeMs > 8000) return "This tool works through Hollycode's remote-control gateway (e.g. Telegram), not in the plain terminal here." } catch {}
  fs.writeFileSync(path.join(inDir, id + ".json"), JSON.stringify({ id, kind, sessionID: ctx && ctx.sessionID ? ctx.sessionID : "", ...payload }))
  const outPath = path.join(outDir, id + ".json")
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400))
    if (fs.existsSync(outPath)) {
      try { const res = JSON.parse(fs.readFileSync(outPath, "utf8")); try { fs.unlinkSync(outPath) } catch {} ; return (res.ok ? "" : "Error: ") + res.message } catch { break }
    }
  }
  return "Search was queued (no result yet)."
}
`

const SEND_MESSAGE_SOURCE = `import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"

const BASE = path.join(os.homedir(), ".config", "hollywood", "agent-cron")

export default {
  description:
    "Send a message proactively to the user in THIS chat, right now, outside the normal reply flow. Use sparingly — e.g. to post an intermediate status during a long task, or when explicitly asked to 'message me' something. The normal way to answer is just your text reply; only use this for an extra out-of-band message.",
  args: {
    text: { type: "string", description: "The message text to send to the user now." },
  },
  async execute(args: any, ctx: any) {
    return await __bridge("send_message", { text: String(args.text || "") }, ctx)
  },
}

async function __bridge(kind: string, payload: any, ctx: any) {
  const id = crypto.randomUUID()
  const inDir = path.join(BASE, "in"), outDir = path.join(BASE, "out")
  fs.mkdirSync(inDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
  // Only the remote-control gateway watches this inbox. If it isn't live (e.g. in
  // the plain terminal/TUI), don't hang — say so immediately.
  try { const a = path.join(BASE, "gateway.alive"); if (!fs.existsSync(a) || Date.now() - fs.statSync(a).mtimeMs > 8000) return "This tool works through Hollycode's remote-control gateway (e.g. Telegram), not in the plain terminal here." } catch {}
  fs.writeFileSync(path.join(inDir, id + ".json"), JSON.stringify({ id, kind, sessionID: ctx && ctx.sessionID ? ctx.sessionID : "", ...payload }))
  const outPath = path.join(outDir, id + ".json")
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400))
    if (fs.existsSync(outPath)) {
      try { const res = JSON.parse(fs.readFileSync(outPath, "utf8")); try { fs.unlinkSync(outPath) } catch {} ; return (res.ok ? "OK: " : "Error: ") + res.message } catch { break }
    }
  }
  return "Message was queued (no confirmation yet)."
}
`

// Self-contained — edits AGENTS.md directly, no gateway bridge, so it also works
// in the terminal/TUI exactly the same.
const MEMORY_SOURCE = `import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export default {
  description:
    "Save or recall durable memories. action='save' stores a fact; action='search' looks one up. " +
    "scope='user' = stable facts about the user across all projects (saved globally); scope='project' = facts about THIS project. " +
    "Save when the user shares a lasting preference, identity detail, decision, or convention worth remembering. Search to recall before answering.",
  args: {
    action: { type: "string", enum: ["save", "search"], description: "save a fact, or search saved memories." },
    text: { type: "string", description: "The fact to save, or the keywords to search for." },
    scope: { type: "string", enum: ["user", "project"], description: "user = global about the user; project = this project. Default user." },
  },
  async execute(args: any) {
    const scope = args.scope === "project" ? "project" : "user"
    const userFile = path.join(os.homedir(), ".config", "opencode", "AGENTS.md")
    const projFile = path.join(process.cwd(), "AGENTS.md")
    const file = scope === "project" ? projFile : userFile
    const header = scope === "project" ? "## Memory" : "## About the user"
    if (args.action === "search") {
      const q = String(args.text || "").toLowerCase().split(/\\s+/).filter(Boolean)
      const hits: string[] = []
      for (const f of [userFile, projFile]) {
        try {
          for (const line of fs.readFileSync(f, "utf8").split("\\n")) {
            const t = line.trim()
            if (t.startsWith("-") && q.some((w: string) => t.toLowerCase().includes(w))) hits.push(t)
          }
        } catch {}
      }
      return hits.length ? "Found in memory:\\n" + hits.slice(0, 20).join("\\n") : "No matching memories."
    }
    const fact = String(args.text || "").trim()
    if (!fact) return "Nothing to save (empty text)."
    let content = ""
    try { content = fs.readFileSync(file, "utf8") } catch {}
    if (!content.includes(header)) content = content.trimEnd() + (content.trim() ? "\\n\\n" : "") + header + "\\n"
    content = content.trimEnd() + "\\n- " + fact + "\\n"
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return "Saved to " + scope + " memory."
  },
}
`

const SAY_SOURCE = `import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"

const BASE = path.join(os.homedir(), ".config", "hollywood", "agent-cron")

export default {
  description:
    "Speak a message ALOUD to the user in this chat — send it as a voice note instead of (or in addition to) text. Use when the user asks you to 'say it', 'send a voice', or read something aloud. Uses the configured text-to-speech voice.",
  args: {
    text: { type: "string", description: "The text to speak aloud." },
  },
  async execute(args: any, ctx: any) {
    return await __bridge("say", { text: String(args.text || "") }, ctx)
  },
}

async function __bridge(kind: string, payload: any, ctx: any) {
  const id = crypto.randomUUID()
  const inDir = path.join(BASE, "in"), outDir = path.join(BASE, "out")
  fs.mkdirSync(inDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
  try { const a = path.join(BASE, "gateway.alive"); if (!fs.existsSync(a) || Date.now() - fs.statSync(a).mtimeMs > 8000) return "This tool works through Hollycode's remote-control gateway (e.g. Telegram), not in the plain terminal here." } catch {}
  fs.writeFileSync(path.join(inDir, id + ".json"), JSON.stringify({ id, kind, sessionID: ctx && ctx.sessionID ? ctx.sessionID : "", ...payload }))
  const outPath = path.join(outDir, id + ".json")
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400))
    if (fs.existsSync(outPath)) {
      try { const res = JSON.parse(fs.readFileSync(outPath, "utf8")); try { fs.unlinkSync(outPath) } catch {} ; return (res.ok ? "OK: " : "Error: ") + res.message } catch { break }
    }
  }
  return "Voice request was queued (no confirmation yet)."
}
`

const TOOL_SOURCES: Record<string, string> = {
  "cronjob.ts": CRONJOB_SOURCE,
  "recall.ts": RECALL_SOURCE,
  "send_message.ts": SEND_MESSAGE_SOURCE,
  "memory.ts": MEMORY_SOURCE,
  "say.ts": SAY_SOURCE,
}

/** Install all agent-facing tools into opencode's global tool dir. */
export function installAgentTools() {
  try {
    fs.mkdirSync(TOOL_DIR, { recursive: true })
    fs.mkdirSync(IN_DIR, { recursive: true })
    fs.mkdirSync(OUT_DIR, { recursive: true })
    for (const [name, source] of Object.entries(TOOL_SOURCES)) {
      const target = path.join(TOOL_DIR, name)
      if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== source) fs.writeFileSync(target, source)
    }
  } catch {
    /* best-effort */
  }
}

export interface AgentInboxDeps {
  scheduler: SchedulerHandle | undefined
  recall: RecallIndex | undefined
  chatForSession: (sid: string) => { channelId: string; conversationId: string } | undefined
  deliver: ((channelId: string, conversationId: string, text: string) => Promise<void>) | undefined
  deliverVoice: ((channelId: string, conversationId: string, audio: Uint8Array) => Promise<void>) | undefined
  speak: ((text: string) => Promise<Uint8Array>) | undefined
  log: (scope: string, message: string) => void
}

/** Process pending agent tool requests (call on an interval). */
export function processAgentInbox(deps: AgentInboxDeps) {
  // Liveness marker so the bridge tools know a gateway is actually watching
  // (otherwise, e.g. in the TUI, they return immediately instead of hanging).
  try { fs.writeFileSync(path.join(BASE, "gateway.alive"), String(Date.now())) } catch {}
  let files: string[]
  try {
    files = fs.readdirSync(IN_DIR).filter((f) => f.endsWith(".json"))
  } catch {
    return
  }
  for (const f of files) {
    const inPath = path.join(IN_DIR, f)
    // CLAIM the request before any async work: this poller runs every 2s, and a
    // request whose handling takes longer (slow deliver/TTS) would otherwise be
    // read AGAIN on the next tick → duplicate cron jobs / duplicate messages.
    // renameSync is atomic on the same dir; if another tick already claimed it,
    // the rename throws and we skip.
    const workPath = inPath + ".working"
    try {
      fs.renameSync(inPath, workPath)
    } catch {
      continue // already claimed (or gone)
    }
    let req: AgentRequest
    try {
      req = JSON.parse(fs.readFileSync(workPath, "utf8")) as AgentRequest
    } catch {
      try { fs.unlinkSync(workPath) } catch {}
      continue
    }
    const respond = (ok: boolean, message: string) => {
      try { fs.writeFileSync(path.join(OUT_DIR, req.id + ".json"), JSON.stringify({ ok, message })) } catch {}
      try { fs.unlinkSync(workPath) } catch {}
    }
    void handleRequest(req, deps, respond)
  }
  // Housekeeping: responses the tool never picked up (its poll window is ~12s)
  // and .working claims orphaned by a crash accumulate forever — sweep >10min old.
  const TEN_MIN = 10 * 60_000
  const sweep = (dir: string, suffix: string) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(suffix)) continue
        const p = path.join(dir, f)
        try {
          if (Date.now() - fs.statSync(p).mtimeMs > TEN_MIN) fs.unlinkSync(p)
        } catch {}
      }
    } catch {}
  }
  sweep(OUT_DIR, ".json")
  sweep(IN_DIR, ".working")
}

async function handleRequest(req: AgentRequest, deps: AgentInboxDeps, respond: (ok: boolean, message: string) => void) {
  const kind = req.kind || "cron"
  try {
    if (kind === "recall") {
      if (!deps.recall) { respond(false, "Recall is not available."); return }
      const hits = deps.recall.search(req.query || "", 8)
      respond(true, hits.length ? hits.map((h) => `• ${h.title}: ${h.snippet}`).join("\n") : "No matching past sessions.")
      return
    }

    if (kind === "send_message") {
      const chat = deps.chatForSession(req.sessionID)
      if (!chat) { respond(false, "Could not resolve which chat to message."); return }
      if (!deps.deliver) { respond(false, "Delivery is not available on this channel."); return }
      const text = (req.text || "").trim()
      if (!text) { respond(false, "Nothing to send (empty text)."); return }
      await deps.deliver(chat.channelId, chat.conversationId, text)
      respond(true, "Message sent.")
      return
    }

    if (kind === "say") {
      const chat = deps.chatForSession(req.sessionID)
      if (!chat) { respond(false, "Could not resolve which chat to speak to."); return }
      if (!deps.speak) { respond(false, "Voice (text-to-speech) is not configured."); return }
      if (!deps.deliverVoice) { respond(false, "This channel can't deliver voice."); return }
      const text = (req.text || "").trim()
      if (!text) { respond(false, "Nothing to say (empty text)."); return }
      const audio = await deps.speak(text)
      await deps.deliverVoice(chat.channelId, chat.conversationId, audio)
      respond(true, "Spoke the message aloud.")
      return
    }

    // default: cron
    if (!deps.scheduler) { respond(false, "Scheduler is not available."); return }
    const chat = deps.chatForSession(req.sessionID)
    // Fail CLOSED for every action: when the session can't be resolved to a chat,
    // "list" must not fall back to showing every conversation's jobs (their
    // prompts + destinations would leak across chats/channels).
    if (!chat) { respond(false, "Could not resolve which chat this session belongs to."); return }
    if (req.action === "create") {
      if (!req.schedule || !req.prompt) { respond(false, "Both a schedule (cron) and a prompt are required."); return }
      const job = deps.scheduler.add({ cron: req.schedule, prompt: req.prompt, channelId: chat!.channelId, conversationId: chat!.conversationId })
      deps.log("cron", `agent scheduled job ${job.id}: ${req.prompt.slice(0, 50)}`)
      respond(true, `Scheduled job ${job.id} — runs on "${req.schedule}". Remove with action="remove", job_id="${job.id}".`)
    } else if (req.action === "list") {
      const jobs = deps.scheduler.list().filter((j) => j.channelId === chat.channelId && j.conversationId === chat.conversationId)
      respond(true, jobs.length ? "Scheduled jobs:\n" + jobs.map((j) => `- ${j.id}: "${j.prompt}" (${j.cron})`).join("\n") : "No scheduled jobs.")
    } else if (req.action === "remove") {
      if (!req.job_id) { respond(false, "job_id is required to remove a job."); return }
      const ok = deps.scheduler.remove(req.job_id)
      respond(ok, ok ? `Removed job ${req.job_id}.` : `No job with id ${req.job_id}.`)
    } else {
      respond(false, `Unknown action "${req.action}". Use create, list, or remove.`)
    }
  } catch (err: any) {
    respond(false, `Failed: ${err?.message ?? err}`)
  }
}
