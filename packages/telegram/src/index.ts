// Hollywood Code — Telegram remote control.
// Work with the agent from your phone. Every prompt goes through the normal
// session path, so the Hollywood router auto-casts the model per message
// (doubles for cheap scenes, the star for hard ones) — for free.
//
// Architecture mirrors packages/slack: boot an embedded opencode server via
// the SDK, map each Telegram chat to a session, stream tool progress back.
import { Bot, type Context } from "grammy"
import { createOpencode, type ToolPart } from "@opencode-ai/sdk"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const TOKEN = process.env["HOLLYWOOD_TG_TOKEN"]
if (!TOKEN) {
  console.error("Missing HOLLYWOOD_TG_TOKEN (get one from @BotFather).")
  process.exit(1)
}

// Allowlist: comma-separated numeric Telegram user IDs. Empty = refuse all
// (fail closed) so the bot is never accidentally open to the world.
const ALLOWED = new Set(
  (process.env["HOLLYWOOD_TG_ALLOWED_IDS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)
if (ALLOWED.size === 0) {
  console.warn("HOLLYWOOD_TG_ALLOWED_IDS is empty — the bot will refuse every message. Set your Telegram user ID.")
}

const DIRECTORY = process.env["HOLLYWOOD_TG_DIRECTORY"] || process.cwd()
const TELEGRAM_MAX = 4096

// chatID -> sessionID, persisted so restarts keep the same threads.
const STORE = path.join(os.homedir(), ".hollywood-telegram-sessions.json")
const chatToSession = new Map<string, string>()
function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8")) as Record<string, string>
    for (const [k, v] of Object.entries(raw)) chatToSession.set(k, v)
  } catch {
    // first run — no store yet
  }
}
function saveStore() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(Object.fromEntries(chatToSession), null, 2))
  } catch (err) {
    console.error("Could not persist session store:", err)
  }
}

console.log("Starting Hollywood Code server...")
const opencode = await createOpencode({ port: 0 })
console.log("Server ready. Project directory:", DIRECTORY)

// Live tool progress: when a tool completes in a session, edit that chat's
// status message so the phone shows "what the agent is doing right now".
const statusMessage = new Map<string, { chatId: number; messageId: number; lines: string[] }>()
void (async () => {
  const events = await opencode.client.event.subscribe()
  for await (const event of events.stream) {
    if (event.type !== "message.part.updated") continue
    const part = event.properties.part
    if (part.type !== "tool") continue
    void handleToolUpdate(part)
  }
})()

async function handleToolUpdate(part: ToolPart) {
  if (part.state.status !== "completed") return
  const status = statusMessage.get(part.sessionID)
  if (!status) return
  status.lines.push(`✓ ${part.tool} — ${part.state.title}`)
  const text = "🎬 working...\n" + status.lines.slice(-8).join("\n")
  await bot.api.editMessageText(status.chatId, status.messageId, text.slice(0, TELEGRAM_MAX)).catch(() => {})
}

const bot = new Bot(TOKEN)

// Fail-closed allowlist gate on every update.
bot.use(async (ctx, next) => {
  const id = ctx.from?.id?.toString()
  if (!id || !ALLOWED.has(id)) {
    console.log("Ignored message from unauthorized id:", id)
    return
  }
  await next()
})

async function getOrCreateSession(chatId: string): Promise<string | undefined> {
  const existing = chatToSession.get(chatId)
  if (existing) return existing
  const created = await opencode.client.session.create({
    body: { title: `Telegram ${chatId}` },
  })
  if (created.error || !created.data) {
    console.error("Failed to create session:", created.error)
    return undefined
  }
  chatToSession.set(chatId, created.data.id)
  saveStore()
  return created.data.id
}

async function sendChunked(ctx: Context, text: string) {
  if (!text) return
  for (let i = 0; i < text.length; i += TELEGRAM_MAX) {
    await ctx.reply(text.slice(i, i + TELEGRAM_MAX))
  }
}

bot.command("start", (ctx) =>
  ctx.reply(
    "🎬 Hollywood Code — remote control\n" +
      "Send me a message and I'll work on your project. The model is cast\n" +
      "automatically per task (cheap doubles, the star for hard work).\n\n" +
      "/new — start a fresh session\n" +
      "/status — show the current session\n" +
      "/stop — abort the running task\n" +
      "/help — this message",
  ),
)
bot.command("help", (ctx) => ctx.reply("/new · /status · /stop — send any text to work on your project."))

bot.command("new", (ctx) => {
  const chatId = ctx.chat.id.toString()
  chatToSession.delete(chatId)
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
    .prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text }] },
    })
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

  // Replace the status message with the model that played the scene, then the answer.
  const model = data.info?.modelID ? `🎬 ${data.info.modelID}` : "🎬 done"
  await bot.api.editMessageText(ctx.chat.id, status.message_id, model).catch(() => {})
  await sendChunked(ctx, reply)
})

loadStore()
bot.start({
  onStart: (info) => console.log(`⚡ Telegram bridge running as @${info.username}. Allowed ids: ${[...ALLOWED].join(", ") || "(none)"}`),
})
