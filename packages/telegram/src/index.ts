// Hollywood Code — Telegram remote control entry point.
// First run with no saved config → interactive setup wizard. After that → goes
// straight online. Work with the agent from your phone; every prompt goes
// through the normal session path, so the Hollywood router auto-casts the
// model per message (doubles for cheap scenes, the star for hard ones).
//
// Architecture mirrors packages/slack: boot an embedded opencode server via
// the SDK, map each Telegram chat to a session, stream tool progress back.
import { Bot, type Context } from "grammy"
import { createOpencodeClient, type ToolPart } from "@opencode-ai/sdk"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadConfig, type RemoteConfig } from "./config"
import { runWizard } from "./setup"

const TELEGRAM_MAX = 4096
const HERE = path.dirname(fileURLToPath(import.meta.url))

// Boot OUR server from source (the SDK's createOpencode spawns a global
// `opencode` binary, which a dev fork doesn't have). Running it ourselves with
// cwd = the project directory also makes the agent operate on the right repo.
// process.execPath is the bun runtime we're already running under.
function bootServer(directory: string): Promise<{ url: string; close: () => void }> {
  const serverIndex = path.resolve(HERE, "../../opencode/src/index.ts")
  const proc = spawn(process.execPath, ["run", serverIndex, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: directory,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  })
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
      const match = buf.match(/listening on\s+(https?:\/\/[^\s]+)/)
      if (match) {
        settled = true
        clearTimeout(timer)
        resolve({ url: match[1]!, close: () => proc.kill() })
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

async function main() {
  // No token anywhere → first-time setup. Otherwise straight to online.
  let config = loadConfig()
  if (!config) {
    config = await runWizard(process.cwd())
  }
  if (config.allowedIds.length === 0) {
    console.warn("No paired users — the bot will refuse every message. Re-run setup to pair your phone.")
  }
  await startBridge(config)
}

async function startBridge(config: RemoteConfig) {
  const ALLOWED = new Set(config.allowedIds)
  const DIRECTORY = config.directory || process.cwd()

  // chatID -> sessionID, persisted so restarts keep the same threads.
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
      fs.writeFileSync(STORE, JSON.stringify(Object.fromEntries(chatToSession), null, 2))
    } catch (err) {
      console.error("Could not persist session store:", err)
    }
  }

  console.log("Starting Hollywood Code server...")
  const server = await bootServer(DIRECTORY)
  const opencode = { client: createOpencodeClient({ baseUrl: server.url }) }
  console.log("Server ready. Project directory:", DIRECTORY)

  const bot = new Bot(config.token)

  // Live tool progress: when a tool completes, edit that chat's status message
  // so the phone shows "what the agent is doing right now".
  const statusMessage = new Map<string, { chatId: number; messageId: number; lines: string[] }>()
  void (async () => {
    const events = await opencode.client.event.subscribe()
    for await (const event of events.stream) {
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

  // Fail-closed allowlist gate on every update.
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

  const sendChunked = async (ctx: Context, text: string) => {
    if (!text) return
    for (let i = 0; i < text.length; i += TELEGRAM_MAX) await ctx.reply(text.slice(i, i + TELEGRAM_MAX))
  }

  bot.command("start", (ctx) =>
    ctx.reply(
      "🎬 Hollywood Code — remote control\n" +
        "Send me a message and I'll work on your project. The model is cast\n" +
        "automatically per task (cheap doubles, the star for hard work).\n\n" +
        "/new — start a fresh session\n/status — show the current session\n/stop — abort the running task\n/help — this message",
    ),
  )
  bot.command("help", (ctx) => ctx.reply("/new · /status · /stop — send any text to work on your project."))
  bot.command("new", (ctx) => {
    chatToSession.delete(ctx.chat.id.toString())
    saveStore()
    return ctx.reply("🆕 New session. Send your next message to begin.")
  })
  bot.command("status", (ctx) => {
    const sessionId = chatToSession.get(ctx.chat.id.toString())
    return ctx.reply(sessionId ? `Session: ${sessionId}\nDirectory: ${DIRECTORY}` : "No active session yet. Send a message.")
  })
  bot.command("stop", async (ctx) => {
    const sessionId = chatToSession.get(ctx.chat.id.toString())
    if (!sessionId) return ctx.reply("No active session.")
    await opencode.client.session.abort({ path: { id: sessionId } }).catch(() => {})
    return ctx.reply("⏹️ Stopped.")
  })

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith("/")) return // unknown command — ignore
    const chatId = ctx.chat.id.toString()

    const sessionId = await getOrCreateSession(chatId)
    if (!sessionId) return ctx.reply("Sorry, I couldn't create a session. Try /new.")

    await ctx.replyWithChatAction("typing").catch(() => {})
    const status = await ctx.reply("🎬 working...")
    statusMessage.set(sessionId, { chatId: ctx.chat.id, messageId: status.message_id, lines: [] })

    // No `model` in the body → the Hollywood router casts it per message.
    const result = await opencode.client.session
      .prompt({ path: { id: sessionId }, body: { parts: [{ type: "text", text }] } })
      .catch((err) => ({ error: err, data: undefined }))

    statusMessage.delete(sessionId)

    if ((result as any).error || !result.data) {
      console.error("Prompt failed:", (result as any).error)
      return ctx.reply("⚠️ Something went wrong handling that. Try again or /new.")
    }

    const data = result.data as any
    const reply =
      data.parts
        ?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")
        .trim() || "(done — no text reply)"

    const model = data.info?.modelID ? `🎬 ${data.info.modelID}` : "🎬 done"
    await bot.api.editMessageText(ctx.chat.id, status.message_id, model).catch(() => {})
    await sendChunked(ctx, reply)
  })

  bot.start({
    onStart: (info) =>
      console.log(`⚡ Remote control online as @${info.username}. Paired ids: ${[...ALLOWED].join(", ") || "(none)"}`),
  })
}

await main()
