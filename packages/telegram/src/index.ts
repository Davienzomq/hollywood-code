import { Bot, type Context } from "grammy"
import { createOpencodeClient, type ToolPart } from "@opencode-ai/sdk"
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadConfig, saveConfig, type RemoteConfig } from "./config"
import { runWizard } from "./setup"

const TELEGRAM_MAX = 4096
const HERE = path.dirname(fileURLToPath(import.meta.url))

let serverProc: ChildProcess | undefined

function bootServer(directory: string): Promise<{ url: string; close: () => void }> {
  const serverIndex = path.resolve(HERE, "../../opencode/src/index.ts")
  const env: Record<string, string> = {
    ...process.env,
    HOLLYWOOD_ROUTER: process.env.HOLLYWOOD_ROUTER ?? "off",
  }
  const proc = spawn(process.execPath, ["run", serverIndex, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  })
  serverProc = proc
  return new Promise((resolve, reject) => {
    let buf = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(new Error("Hollywood Code server did not start in time"))
    }, 30000)
    proc.stdout.on("data", (chunk: Buffer) => {
      if (settled) return
      buf += chunk.toString()
      const match = buf.match(/server listening on\s+(https?:\/\/[^\s]+)/)
      if (match) {
        settled = true
        clearTimeout(timer)
        resolve({ url: match[1]!, close: () => { proc.kill(); serverProc = undefined } })
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

function cleanup() {
  if (serverProc) {
    serverProc.kill()
    serverProc = undefined
  }
}

async function main() {
  let config = loadConfig()
  if (!config) {
    config = await runWizard(process.cwd())
  }
  if (config.allowedIds.length === 0) {
    console.warn("No paired users — the bot will refuse every message. Re-run setup to pair your phone.")
  }
  await startBridge(config)
}

export async function startBridge(config: RemoteConfig) {
  const ALLOWED = new Set(config.allowedIds)
  let DIRECTORY = config.directory || process.cwd()

  const STORE = path.join(os.homedir(), ".hollywood-telegram-sessions.json")
  const chatToSession = new Map<string, string>()
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8")) as Record<string, string>
    for (const [k, v] of Object.entries(raw)) chatToSession.set(k, v)
  } catch {
    // first run — no store yet
  }
  const saveStore = () => {
    try {
      const tmp = STORE + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(chatToSession), null, 2))
      fs.renameSync(tmp, STORE)
    } catch (err) {
      console.error("Could not persist session store:", err)
    }
  }

  // Permission mode: autoAllow=true → everything runs without asking;
  // false (default) → server asks and we forward the request to Telegram buttons.
  let autoAllow = config.autoAllow ?? false
  const permissionBlock = () =>
    autoAllow
      ? { external_directory: "allow", bash: "allow", read: "allow", write: "allow", edit: "allow", webfetch: "allow" }
      : { external_directory: "ask", bash: "ask", read: "allow", write: "ask", edit: "ask", webfetch: "allow" }
  const applyPermissionMode = () => {
    try {
      const p = path.join(DIRECTORY, "opencode.jsonc")
      const raw = fs.existsSync(p)
        ? (JSON.parse(fs.readFileSync(p, "utf8")) as any)
        : { $schema: "https://opencode.ai/config.json" }
      raw.permission = permissionBlock()
      fs.writeFileSync(p, JSON.stringify(raw, null, 2))
      console.log(`Permission mode: ${autoAllow ? "auto-allow" : "ask via Telegram"}`)
    } catch (err) {
      console.error("Could not update opencode.jsonc:", err)
    }
  }
  applyPermissionMode()

  console.log("Starting Hollywood Code server...")
  let server = await bootServer(DIRECTORY)
  let opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
  let opencodeV2 = createV2Client({ baseUrl: server.url })
  console.log("Server ready. Project directory:", DIRECTORY)

  // Auto-detect default model from the local OpenCode server
  let defaultModel: { providerID: string; modelID: string } | undefined
  try {
    const prov = await opencode.client.config.providers()
    const defaults = prov.data?.default as Record<string, string> | undefined
    if (defaults) {
      const entries = Object.entries(defaults)
      const preferred = entries.find(([id]) => id === "opencode") ?? entries[0]
      if (preferred) defaultModel = { providerID: preferred[0], modelID: preferred[1] }
    }
    if (defaultModel) console.log("Model auto-detected:", defaultModel.providerID + "/" + defaultModel.modelID)
  } catch {
    console.log("Could not detect default model, using server default")
  }

  const bot = new Bot(config.token)

  const statusMessage = new Map<string, { chatId: number; messageId: number; lines: string[] }>()
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
        const status = statusMessage.get(part.sessionID)
        if (!status) continue
        status.lines.push(`✓ ${part.tool} — ${part.state.title}`)
        const text = "🎬 working...\n" + status.lines.slice(-8).join("\n")
        await bot.api.editMessageText(status.chatId, status.messageId, text.slice(0, TELEGRAM_MAX)).catch(() => {})
      }
    })()
  }
  startEvents()

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id?.toString()
    if (!id || !ALLOWED.has(id)) {
      console.log("Ignored message from unauthorized id:", id)
      return
    }
    await next()
  })

  const getOrCreateSession = async (chatId: string): Promise<string | undefined> => {
    const existing = chatToSession.get(chatId)
    if (existing) return existing
    const created = await opencode.client.session.create({ body: { title: `Telegram ${chatId}` } })
    if (created.error || !created.data) {
      console.error("Failed to create session:", created.error)
      return undefined
    }
    chatToSession.set(chatId, created.data.id)
    saveStore()
    return created.data.id
  }

  const syncModelToFile = (model: string) => {
    try {
      const p = path.join(DIRECTORY, "opencode.jsonc")
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as any
      raw.model = model
      fs.writeFileSync(p, JSON.stringify(raw, null, 2))
    } catch { /* best-effort */ }
  }

  const sendChunked = async (ctx: Context, text: string) => {
    if (!text) return
    for (let i = 0; i < text.length; i += TELEGRAM_MAX) await ctx.reply(text.slice(i, i + TELEGRAM_MAX))
  }

  // Pending approvals forwarded to Telegram (short keys: callback_data is limited to 64 bytes)
  let cbSeq = 0
  const pendingPerms = new Map<string, { api: "v1" | "v2"; sessionID: string; requestID: string }>()
  const pendingQuestions = new Map<string, { sessionID: string; requestID: string; request: any }>()
  const notified = new Set<string>()

  const replyPermission = async (p: { api: "v1" | "v2"; sessionID: string; requestID: string }, reply: "once" | "always" | "reject") => {
    if (p.api === "v1") {
      await opencodeV2.permission.reply({ requestID: p.requestID, reply }).catch(() => {})
    } else {
      await opencodeV2.v2.session.permission.reply({ sessionID: p.sessionID, requestID: p.requestID, reply }).catch(() => {})
    }
  }

  const notifyPermission = async (
    chatId: number,
    api: "v1" | "v2",
    r: any,
    label: string,
  ) => {
    const key = String(++cbSeq)
    pendingPerms.set(key, { api, sessionID: r.sessionID, requestID: r.id })
    await bot.api
      .sendMessage(chatId, `🔐 Permission request:\n${label}`.slice(0, TELEGRAM_MAX), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Allow once", callback_data: `pa:${key}:o` },
              { text: "♾️ Always", callback_data: `pa:${key}:a` },
              { text: "❌ Deny", callback_data: `pa:${key}:r` },
            ],
          ],
        },
      })
      .catch(() => {})
  }

  const resolvePending = async (sid?: string, chatId?: number) => {
    // permissions — the server publishes them on the GLOBAL /permission endpoint
    // (v1 shape: permission/patterns); v2 session-scoped list kept as fallback.
    const globalPerms = await opencodeV2.permission.list({}).catch(() => null)
    const v1Requests: any[] = (globalPerms?.data as any) ?? []
    for (const r of v1Requests) {
      if (sid && r.sessionID !== sid) continue
      if (autoAllow) {
        await opencodeV2.permission.reply({ requestID: r.id, reply: "always" }).catch(() => {})
        continue
      }
      if (notified.has(r.id) || !chatId) continue
      notified.add(r.id)
      const label = `${r.permission}${r.patterns?.length ? "\n" + r.patterns.slice(0, 5).join("\n") : ""}${r.metadata?.filepath ? `\n📄 ${r.metadata.filepath}` : ""}`
      await notifyPermission(chatId, "v1", r, label)
    }
    if (sid) {
      const perms = await opencodeV2.v2.session.permission.list({ sessionID: sid }).catch(() => null)
      const requests: any[] = (perms?.data as any)?.data ?? []
      for (const r of requests) {
        if (autoAllow) {
          await opencodeV2.v2.session.permission.reply({ sessionID: sid, requestID: r.id, reply: "always" }).catch(() => {})
          continue
        }
        if (notified.has(r.id) || !chatId) continue
        notified.add(r.id)
        const label = `${r.action}${r.resources?.length ? "\n" + r.resources.slice(0, 5).join("\n") : ""}`
        await notifyPermission(chatId, "v2", r, label)
      }
    }
    // questions
    const all: any = await opencodeV2.question.list({}).catch(() => null)
    const qs: any[] = all?.data ?? []
    for (const q of qs) {
      if (sid && q.sessionID !== sid) continue
      const first = q.questions?.[0]
      if (autoAllow || !first?.options?.length || !chatId) {
        if (!autoAllow && !chatId) continue // ask mode but nowhere to send — leave pending
        const answers: string[][] =
          q.questions?.map((qq: any) => (qq.options?.[0]?.label ? [qq.options[0].label] : ["ok"])) ?? []
        await opencodeV2.v2.session.question
          .reply({ sessionID: q.sessionID, requestID: q.id, questionV2Reply: { answers } })
          .catch(() => {})
        continue
      }
      if (notified.has(q.id)) continue
      notified.add(q.id)
      const key = String(++cbSeq)
      pendingQuestions.set(key, { sessionID: q.sessionID, requestID: q.id, request: q })
      const rows = first.options
        .slice(0, 8)
        .map((o: any, i: number) => [{ text: String(o.label || `Option ${i + 1}`).slice(0, 60), callback_data: `qa:${key}:${i}` }])
      await bot.api
        .sendMessage(chatId, `❓ ${first.question}`.slice(0, TELEGRAM_MAX), {
          reply_markup: { inline_keyboard: rows },
        })
        .catch(() => {})
    }
  }

  const sessionIdFor = (ctx: Context) => chatToSession.get(ctx.chat!.id.toString())

  bot.command("start", (ctx) =>
    ctx.reply(
      "🎬 Hollywood Code — remote control\n" +
        "Send me a message and I'll work on your project.\n\n" +
        "/new · /sessions · /status · /stop · /model · /undo · /fork\n" +
        "/rename · /compact · /export · /copy · /agents · /skills\n" +
        "/review · /init · /share · /move · /thinking · /help",
    ),
  )

  bot.command("new", (ctx) => {
    chatToSession.delete(ctx.chat.id.toString())
    saveStore()
    return ctx.reply("🆕 New session. Send your next message to begin.")
  })

  bot.command("status", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    const s = await opencode.client.session.get({ path: { id: sid } }).catch(() => null)
    const m = s?.data ? `${(s.data as any).title} (${sid.slice(0, 12)}…)` : sid
    return ctx.reply(`📁 ${m}\n📂 ${DIRECTORY}`)
  })

  bot.command("stop", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    await opencode.client.session.abort({ path: { id: sid } }).catch(() => {})
    return ctx.reply("⏹️ Stopped.")
  })

  bot.command("model", async (ctx) => {
    const msg = ctx.message!
    const text = msg.text.slice("/model".length).trim()
    if (text) {
      const parts = text.split("/")
      if (parts.length < 2) return ctx.reply("Invalid format. Use: /model providerID/modelID")
      defaultModel = { providerID: parts[0], modelID: parts.slice(1).join("/") }
      config.model = text
      saveConfig(config)
      await opencode.client.config.update({ body: { model: text } as any }).catch(() => {})
      syncModelToFile(text)
      return ctx.reply(`✅ Model set to ${text}`)
    }
    const prov = await opencode.client.config.providers().catch(() => null)
    if (!prov?.data) return ctx.reply("Could not fetch providers.")
    const providers: any[] = (prov.data as any).providers ?? []
    if (!providers.length) return ctx.reply("No providers available.")
    const cur = defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}` : "server default"
    const rows = providers.map((p: any) => {
      const keys = Object.keys(p.models || {})
      if (!keys.length) return []
      return [{ text: `🤖 ${p.name} (${keys.length})`, callback_data: `mp:${p.id}` }]
    }).filter((r: any) => r.length)
    const chunked: any[] = []
    for (let i = 0; i < rows.length; i += 2) chunked.push(rows.slice(i, i + 2).flat())
    await ctx.reply(`🤖 *Current:* ${cur}\n\nSelect a provider:`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: chunked },
    })
  })

  bot.command(["sessions", "s"], async (ctx) => {
    const msg = ctx.message!
    const text = msg.text.slice(msg.text.startsWith("/s") ? 9 : 4).trim()
    if (text) {
      chatToSession.delete(ctx.chat.id.toString())
      chatToSession.set(ctx.chat.id.toString(), text)
      saveStore()
      return ctx.reply(`✅ Switched to session: ${text}`)
    }
    const list = await opencode.client.session.list({}).catch(() => null)
    if (!list?.data) return ctx.reply("No sessions found.")
    const all: any[] = list.data as any[]
    const sid = sessionIdFor(ctx)
    const rows = all.slice(0, 20).map((s: any) =>
      [{ text: `${s.id === sid ? "👉 " : ""}${s.title || "untitled"} (${s.id.slice(0, 8)})`, callback_data: `ss:${s.id}` }],
    )
    const chunked: any[] = []
    for (let i = 0; i < rows.length; i += 2) chunked.push(rows.slice(i, i + 2).flat())
    await ctx.reply("📋 *Sessions* — tap to switch:", { parse_mode: "Markdown", reply_markup: { inline_keyboard: chunked } })
  })

  bot.command("undo", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    await opencode.client.session.revert({ path: { id: sid } }).catch(() => {})
    return ctx.reply("↩️ Undone last message.")
  })

  bot.command("compact", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    await opencodeV2.v2.session.compact({ sessionID: sid }).catch(() => {})
    return ctx.reply("📦 Session compacted.")
  })

  bot.command("rename", async (ctx) => {
    const name = ctx.message!.text.slice("/rename".length).trim()
    if (!name) return ctx.reply("Usage: /rename <new name>")
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    await opencode.client.session.update({ path: { id: sid }, body: { title: name } as any }).catch(() => {})
    return ctx.reply(`✏️ Renamed to: ${name}`)
  })

  bot.command("fork", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    const name = ctx.message!.text.slice("/fork".length).trim() || `Fork of ${sid.slice(0, 8)}`
    const f = await opencode.client.session.fork({ path: { id: sid }, body: { title: name } as any }).catch(() => null)
    if (!f?.data) return ctx.reply("⚠️ Fork failed.")
    chatToSession.set(ctx.chat.id.toString(), (f.data as any).id)
    saveStore()
    return ctx.reply(`🔀 Forked. New session: ${(f.data as any).id}`)
  })

  bot.command("export", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    const msgs = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
    if (!msgs?.data) return ctx.reply("No messages.")
    const lines = (msgs.data as any[]).map((m: any) => `[${m.role}]\n${m.parts?.map((p: any) => p.text || "").join("\n") || ""}`)
    const text = lines.join("\n\n").slice(0, TELEGRAM_MAX * 8)
    await sendChunked(ctx, text || "(empty transcript)")
  })

  bot.command("copy", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    const msgs = await opencode.client.session.messages({ path: { id: sid } }).catch(() => null)
    if (!msgs?.data) return ctx.reply("No messages.")
    const lines = (msgs.data as any[]).map((m: any) => `[${m.role}]\n${m.parts?.map((p: any) => p.text || "").join("\n") || ""}`)
    await sendChunked(ctx, lines.join("\n\n").slice(0, TELEGRAM_MAX * 8))
  })

  bot.command("agents", async (ctx) => {
    const list = await opencodeV2.v2.agent.list({}).catch(() => null)
    const agents: any[] = (list?.data as any)?.data
    if (!agents?.length) return ctx.reply("No agents available.")
    const rows = agents.map((a: any) => `\`${a.id}\` — ${a.name || a.id}`)
    return ctx.reply(`🧠 Agents:\n${rows.join("\n")}`)
  })

  bot.command("skills", async (ctx) => {
    const list = await opencodeV2.v2.skill.list({}).catch(() => null)
    const skills: any[] = (list?.data as any)?.data
    if (!skills?.length) return ctx.reply("No skills available.")
    const rows = skills.slice(0, 20).map((s: any) => `\`${s.id}\` — ${s.name || s.id}`)
    return ctx.reply(`🛠 Skills:\n${rows.join("\n")}`)
  })

  bot.command("init", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    await opencode.client.session.init({ path: { id: sid }, body: { directory: DIRECTORY } as any }).catch(() => {})
    return ctx.reply("📝 Session initialized with AGENTS.md.")
  })

  bot.command("share", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    const res = await opencode.client.session.share({ path: { id: sid } }).catch(() => null)
    if (!res?.data) return ctx.reply("⚠️ Share failed.")
    return ctx.reply(`🔗 Shared: ${(res.data as any).url || (res.data as any).id}`)
  })

  bot.command("review", async (ctx) => {
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    const diff = await opencode.client.session.diff({ path: { id: sid } }).catch(() => null)
    if (!diff?.data) return ctx.reply("No changes to review.")
    await sendChunked(ctx, (diff.data as any).diff || JSON.stringify(diff.data, null, 2).slice(0, TELEGRAM_MAX * 4))
  })

  bot.command("move", async (ctx) => {
    const msg = ctx.message!
    const dir = msg.text.slice("/move".length).trim()
    if (dir) {
      if (!fs.existsSync(dir)) return ctx.reply("⚠️ Directory does not exist.")
      return await switchDir(ctx, dir)
    }
    const desk = path.join(os.homedir(), "OneDrive", "OneDrive - Bedroom Elegance", "Desktop")
    let folders: string[] = []
    try {
      folders = fs.readdirSync(desk).filter((f) => {
        const full = path.join(desk, f)
        return fs.statSync(full).isDirectory()
      })
    } catch { /* best-effort */ }
    // also add the current directory
    if (!folders.includes(DIRECTORY)) folders.unshift(DIRECTORY)
    const rows = folders.slice(0, 20).map((f: string) =>
      [{ text: `${f === DIRECTORY ? "📍 " : ""}${path.basename(f)}`, callback_data: `mv:${f}` }],
    )
    const chunked: any[] = []
    for (let i = 0; i < rows.length; i += 2) chunked.push(rows.slice(i, i + 2).flat())
    await ctx.reply("📂 *Select a directory:*", { parse_mode: "Markdown", reply_markup: { inline_keyboard: chunked } })
  })

  async function switchDir(ctx: Context, dir: string) {
    dir = path.resolve(dir)
    if (!fs.existsSync(dir)) {
      await ctx.reply("⚠️ Directory does not exist.").catch(() => {})
      return
    }
    config.directory = dir
    saveConfig(config)
    DIRECTORY = dir
    const cfgPath = path.join(dir, "opencode.jsonc")
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        permission: { external_directory: "allow", bash: "allow", read: "allow", write: "allow" },
      }, null, 2))
    }
    server.close()
    chatToSession.clear()
    saveStore()
    server = await bootServer(DIRECTORY)
    opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
    opencodeV2 = createV2Client({ baseUrl: server.url })
    startEvents()
    try {
      const prov = await opencode.client.config.providers()
      const defaults = prov.data?.default as Record<string, string> | undefined
      if (defaults) {
        const preferred = Object.entries(defaults).find(([id]) => id === "opencode") ?? Object.entries(defaults)[0]
        if (preferred) defaultModel = { providerID: preferred[0], modelID: preferred[1] }
      }
    } catch { /* ok */ }
    await ctx.reply(`✅ Switched to \`${dir}\``, { parse_mode: "Markdown" }).catch(() => {})
  }

  bot.command("thinking", async (ctx) => {
    const val = ctx.message!.text.slice("/thinking".length).trim()
    const sid = sessionIdFor(ctx)
    if (!sid) return ctx.reply("No active session.")
    if (val) {
      await opencode.client.session.update({ path: { id: sid }, body: { thinking: val } as any }).catch(() => {})
      return ctx.reply(`🧠 Thinking set to: ${val}`)
    }
    const s = await opencode.client.session.get({ path: { id: sid } }).catch(() => null)
    const current = (s?.data as any)?.thinking || "default"
    return ctx.reply(`🧠 Current thinking: ${current}\nUsage: /thinking on|off|auto`)
  })

  bot.command("autoallow", async (ctx) => {
    const arg = ctx.message!.text.slice("/autoallow".length).trim().toLowerCase()
    if (arg !== "on" && arg !== "off") {
      return ctx.reply(
        `🔐 Auto-allow is ${autoAllow ? "ON — everything approved automatically" : "OFF — approvals come here as buttons"}\nUsage: /autoallow on|off`,
      )
    }
    const next = arg === "on"
    if (next === autoAllow) return ctx.reply(`Already ${arg}.`)
    autoAllow = next
    config.autoAllow = autoAllow
    saveConfig(config)
    applyPermissionMode()
    await ctx.reply(`♻️ Applying ${autoAllow ? "auto-allow" : "ask"} mode — restarting server...`)
    try {
      server.close()
      server = await bootServer(DIRECTORY)
      opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
      opencodeV2 = createV2Client({ baseUrl: server.url })
      startEvents()
    } catch (err) {
      console.error("Restart failed:", err)
      return ctx.reply("⚠️ Server restart failed — try /move to the same directory or restart the bot.")
    }
    return ctx.reply(
      autoAllow
        ? "✅ Auto-allow ON — tasks run without asking."
        : "🔐 Ask mode ON — permission requests will arrive here with Approve/Deny buttons.",
    )
  })

  bot.command(["diff", "editor", "exit", "themes", "timeline", "timestamps", "stuntdouble", "connect", "mcps"], (ctx) =>
    ctx.reply(`⚠️ \`/${ctx.message!.text.split(" ")[0].slice(1)}\` is a CLI-only command.`),
  )

  bot.command("help", (ctx) =>
    ctx.reply(
      "🎬 Commands:\n" +
        "/new — fresh session\n/sessions — list or switch session\n/status — current session\n/stop — abort task\n" +
        "/model — show or change model\n/undo — undo last\n/fork — fork session\n/rename — rename session\n" +
        "/compact — compact session\n/export — export transcript\n/copy — copy transcript\n/agents — list agents\n" +
        "/skills — list skills\n/init — init with AGENTS.md\n/share — share session\n/review — review changes\n" +
        "/move — change project dir\n/thinking — toggle thinking\n/remote — connection status\n" +
        "/autoallow — on: approve everything · off: ask here with buttons\n\nSend any text to work on your project.",
    ),
  )

  // model picker: provider → model list
  bot.callbackQuery(/^mp:(.+)/, async (ctx) => {
    const pid = ctx.callbackQuery.data!.split(":")[1]
    const prov = await opencode.client.config.providers().catch(() => null)
    const providers: any[] = (prov?.data as any)?.providers ?? []
    const p = providers.find((x: any) => x.id === pid)
    if (!p) return ctx.answerCallbackQuery("Provider not found")
    const keys = Object.keys(p.models || {})
    const rows = keys.map((k: string) => {
      const m = p.models[k]
      return [{ text: `🧠 ${m.name || k}`, callback_data: `mm:${pid}:${k}` }]
    })
    const chunked: any[] = []
    for (let i = 0; i < rows.length; i += 2) chunked.push(rows.slice(i, i + 2).flat())
    await ctx.editMessageText(`🤖 *${p.name}* — Select a model:`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: chunked },
    })
    await ctx.answerCallbackQuery()
  })

  // model picker: set model
  bot.callbackQuery(/^mm:(.+):(.+)/, async (ctx) => {
    const [_, pid, mid] = ctx.callbackQuery.data!.split(":")
    const full = `${pid}/${mid}`
    defaultModel = { providerID: pid, modelID: mid }
    config.model = full
    saveConfig(config)
    await opencode.client.config.update({ body: { model: full } as any }).catch(() => {})
    syncModelToFile(full)
    await ctx.editMessageText(`✅ Model set to \`${full}\``, { parse_mode: "Markdown" })
    await ctx.answerCallbackQuery()
  })

  // permission approval buttons
  bot.callbackQuery(/^pa:(.+):(o|a|r)$/, async (ctx) => {
    const [, key, code] = ctx.callbackQuery.data!.split(":")
    const p = pendingPerms.get(key!)
    if (!p) return ctx.answerCallbackQuery({ text: "Expired" })
    pendingPerms.delete(key!)
    const reply = code === "o" ? "once" : code === "a" ? "always" : "reject"
    await replyPermission(p, reply as "once" | "always" | "reject")
    const label = reply === "once" ? "✅ Allowed once" : reply === "always" ? "♾️ Always allowed" : "❌ Denied"
    const original = ctx.callbackQuery.message?.text ?? "🔐 Permission request"
    await ctx.editMessageText(`${original}\n\n${label}`.slice(0, TELEGRAM_MAX)).catch(() => {})
    await ctx.answerCallbackQuery({ text: label })
  })

  // question answer buttons
  bot.callbackQuery(/^qa:(.+):(\d+)$/, async (ctx) => {
    const [, key, idxRaw] = ctx.callbackQuery.data!.split(":")
    const q = pendingQuestions.get(key!)
    if (!q) return ctx.answerCallbackQuery({ text: "Expired" })
    pendingQuestions.delete(key!)
    const idx = Number(idxRaw)
    const questions: any[] = q.request.questions ?? []
    // chosen option answers the first question; any extra questions get their first option
    const answers: string[][] = questions.map((qq: any, i: number) => {
      const label = i === 0 ? qq.options?.[idx]?.label : qq.options?.[0]?.label
      return [label || "ok"]
    })
    await opencodeV2.v2.session.question
      .reply({ sessionID: q.sessionID, requestID: q.requestID, questionV2Reply: { answers } })
      .catch(() => {})
    const chosen = questions[0]?.options?.[idx]?.label || "ok"
    await ctx.editMessageText(`❓ ${questions[0]?.question || "Question"}\n\n👉 ${chosen}`.slice(0, TELEGRAM_MAX)).catch(() => {})
    await ctx.answerCallbackQuery({ text: "Answered" })
  })

  // session picker: switch session
  bot.callbackQuery(/^ss:(.+)/, async (ctx) => {
    const sid = ctx.callbackQuery.data!.split(":")[1]
    chatToSession.delete(ctx.chat!.id.toString())
    chatToSession.set(ctx.chat!.id.toString(), sid)
    saveStore()
    const s = await opencode.client.session.get({ path: { id: sid } }).catch(() => null)
    const title = (s?.data as any)?.title || sid
    await ctx.editMessageText(`✅ Switched to *${title}*`, { parse_mode: "Markdown" })
    await ctx.answerCallbackQuery()
  })

  // directory picker: switch directory
  bot.callbackQuery(/^mv:(.+)/, async (ctx) => {
    const d = ctx.callbackQuery.data!.slice(3)
    await switchDir(ctx, d)
    await ctx.answerCallbackQuery()
  })

  bot.command("remote", async (ctx) => {
    const sid = sessionIdFor(ctx)
    const s = sid ? await opencode.client.session.get({ path: { id: sid } }).catch(() => null) : null
    const title = ((s?.data as any)?.title || "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&")
    const m = defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}` : "server default"
    const sessionLabel = sid ? `${title} (${sid.slice(0, 12)}…)` : "no active session"
    await ctx.reply(
      "✅ *You're connected to Telegram*\n" +
      `📁 Directory: \`${DIRECTORY}\`\n` +
      `🤖 Model: \`${m}\`\n` +
      `📋 Session: ${sessionLabel}\n` +
      `👤 User: \`${ctx.from!.id}\``,
      { parse_mode: "Markdown" },
    )
  })

  bot.on("message:text", (ctx) => {
    const text = ctx.message.text
    if (text.startsWith("/")) return

    // Run the whole prompt flow DETACHED. grammY processes Telegram updates
    // sequentially, so awaiting the prompt here would block the Allow/Deny
    // callback_query from ever being handled: the prompt waits for the
    // permission reply, the reply waits for this handler → deadlock.
    void (async () => {
      const chatId = ctx.chat.id.toString()

      const sessionId = await getOrCreateSession(chatId)
      if (!sessionId) {
        await ctx.reply("Sorry, I couldn't create a session. Try /new.")
        return
      }

      await ctx.replyWithChatAction("typing").catch(() => {})
      const status = await ctx.reply("🎬 working...")
      statusMessage.set(sessionId, { chatId: ctx.chat.id, messageId: status.message_id, lines: [] })

      await resolvePending(sessionId, ctx.chat.id)

      const promptBody: any = { parts: [{ type: "text", text }] }
      if (defaultModel) promptBody.model = defaultModel

      const poller = setInterval(() => { void resolvePending(sessionId, ctx.chat.id) }, 3000)
      const result = await opencode.client.session
        .prompt({ path: { id: sessionId }, body: promptBody })
        .catch((err) => ({ error: err, data: undefined }))
      clearInterval(poller)
      await resolvePending(sessionId, ctx.chat.id)

      statusMessage.delete(sessionId)

      if ((result as any).error || !result.data) {
        console.error("Prompt failed:", (result as any).error)
        await ctx.reply("⚠️ Something went wrong. Try again or /new.")
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
        await bot.api.editMessageText(ctx.chat.id, status.message_id, modelLabel).catch(() => {})
        await sendChunked(ctx, reply)
      } else {
        // No text parts — show error info if available
        const errorPart = parts?.find((p) => p.type === "retry")
        const errorMsg = errorPart ? `⚠️ ${(errorPart as any).error?.data?.message || "Error"}` : "⚠️ No text response"
        await bot.api.editMessageText(ctx.chat.id, status.message_id, `${modelLabel}\n${errorMsg}`).catch(() => {})
      }
    })().catch((err) => console.error("Prompt flow failed:", err))
  })

  process.on("SIGINT", () => {
    console.log("\nShutting down...")
    cleanup()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    cleanup()
    process.exit(0)
  })

  // Register commands menu with Telegram
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Welcome message" },
      { command: "new", description: "Fresh session" },
      { command: "sessions", description: "List or switch session" },
      { command: "status", description: "Current session info" },
      { command: "stop", description: "Abort running task" },
      { command: "model", description: "Show or change model" },
      { command: "undo", description: "Undo last message" },
      { command: "fork", description: "Fork current session" },
      { command: "rename", description: "Rename session" },
      { command: "compact", description: "Compact session" },
      { command: "export", description: "Export transcript" },
      { command: "copy", description: "Copy transcript" },
      { command: "agents", description: "List agents" },
      { command: "skills", description: "List skills" },
      { command: "init", description: "Init with AGENTS.md" },
      { command: "share", description: "Share session" },
      { command: "review", description: "Review changes" },
      { command: "move", description: "Change project dir" },
      { command: "thinking", description: "Toggle thinking" },
      { command: "autoallow", description: "Auto-approve on/off" },
      { command: "remote", description: "Connection status" },
      { command: "help", description: "Show all commands" },
    ])
    console.log("Commands menu registered")
  } catch {
    console.log("Could not register commands menu")
  }

  bot.catch((err) => {
    console.error("Bot error (caught):", err.message)
  })

  bot.start({
    onStart: (info) =>
      console.log(`⚡ Remote control online as @${info.username}. Paired ids: ${[...ALLOWED].join(", ") || "(none)"}`),
  })
}

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err)
  cleanup()
  process.exit(1)
})

// Only self-start when src/index.ts is the entrypoint. The bin/hollycode-remote.ts
// launcher imports startBridge and starts the bridge itself — matching it here
// caused TWO bots polling the same token (Telegram 409 conflicts).
const isMain = process.argv[1] ? path.basename(process.argv[1]) === "index.ts" : false
if (isMain) {
  await main()
}
