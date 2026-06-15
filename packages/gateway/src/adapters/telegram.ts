import { Bot, InputFile, type Context } from "grammy"
import type { ChannelAdapter, GatewayContext, Responder, StatusHandle, IncomingMessage } from "../types"

const TELEGRAM_MAX = 4096

// Per-adapter incrementing counter for callback_data keys.
// Kept module-level so each createTelegramAdapter() call gets its own closure.

function makeTelegramAdapter(token: string): ChannelAdapter {
  const bot = new Bot(token)

  // Pending resolvers for permission and question callbacks.
  let cbSeq = 0
  const pendingPerms = new Map<string, (decision: "once" | "always" | "reject") => void>()
  const pendingQuestions = new Map<string, (chosen: string) => void>()

  // ── Callback query handlers (registered once, before bot.start) ───────────

  // permission approval: pa:<key>:(o|a|r)
  bot.callbackQuery(/^pa:(.+):(o|a|r)$/, async (ctx) => {
    const [, key, code] = ctx.callbackQuery.data!.split(":")
    const resolve = pendingPerms.get(key!)
    if (!resolve) {
      await ctx.answerCallbackQuery({ text: "Expired" })
      return
    }
    pendingPerms.delete(key!)
    const decision: "once" | "always" | "reject" =
      code === "o" ? "once" : code === "a" ? "always" : "reject"
    resolve(decision)
    const label =
      decision === "once" ? "✅ Allowed once" : decision === "always" ? "♾️ Always allowed" : "❌ Denied"
    const original = ctx.callbackQuery.message?.text ?? "🔐 Permission request"
    await ctx.editMessageText(`${original}\n\n${label}`.slice(0, TELEGRAM_MAX)).catch(() => {})
    await ctx.answerCallbackQuery({ text: label })
  })

  // question answer: qa:<key>:<index>
  bot.callbackQuery(/^qa:(.+):(\d+)$/, async (ctx) => {
    const [, key, idxRaw] = ctx.callbackQuery.data!.split(":")
    const resolve = pendingQuestions.get(key!)
    if (!resolve) {
      await ctx.answerCallbackQuery({ text: "Expired" })
      return
    }
    // We need the label — it was embedded in the keyboard button text.
    // Reconstruct from the message's reply_markup.
    const idx = Number(idxRaw)
    const rows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? []
    // Flatten all buttons and find the one whose callback_data matches.
    // Cast to any: InlineKeyboardButton is a discriminated union and we need
    // to read callback_data at runtime — the same style index.ts uses.
    let chosen = `Option ${idx + 1}`
    for (const row of rows) {
      for (const btn of row as any[]) {
        if ((btn as any).callback_data === ctx.callbackQuery.data) {
          chosen = (btn as any).text
          break
        }
      }
    }
    pendingQuestions.delete(key!)
    resolve(chosen)
    const question = ctx.callbackQuery.message?.text ?? "❓ Question"
    await ctx.editMessageText(`${question}\n\n👉 ${chosen}`.slice(0, TELEGRAM_MAX)).catch(() => {})
    await ctx.answerCallbackQuery({ text: "Answered" })
  })

  // ── Responder factory ─────────────────────────────────────────────────────

  function makeResponder(chatId: number, gramCtx?: Context): Responder {
    // sendText: chunk at 4096 chars
    const sendText = async (text: string): Promise<void> => {
      if (!text) return
      for (let i = 0; i < text.length; i += TELEGRAM_MAX) {
        const chunk = text.slice(i, i + TELEGRAM_MAX)
        if (gramCtx) {
          await gramCtx.reply(chunk)
        } else {
          await bot.api.sendMessage(chatId, chunk)
        }
      }
    }

    // typing indicator
    const typing = async (): Promise<void> => {
      await bot.api.sendChatAction(chatId, "typing").catch(() => {})
    }

    // live status message
    const startStatus = async (initial: string): Promise<StatusHandle> => {
      const sent = await bot.api.sendMessage(chatId, initial.slice(0, TELEGRAM_MAX))
      const messageId = sent.message_id

      const update = async (text: string): Promise<void> => {
        await bot.api.editMessageText(chatId, messageId, text.slice(0, TELEGRAM_MAX)).catch(() => {})
      }

      const finalize = async (label: string): Promise<void> => {
        await bot.api.editMessageText(chatId, messageId, label.slice(0, TELEGRAM_MAX)).catch(() => {})
      }

      return { update, finalize }
    }

    // permission request with inline buttons
    const askPermission = (ask: { action: string; detail: string }): Promise<"once" | "always" | "reject"> => {
      return new Promise(async (resolve) => {
        const key = String(++cbSeq)
        pendingPerms.set(key, resolve)
        const text = `🔐 Permission request:\n${ask.action}\n${ask.detail}`.slice(0, TELEGRAM_MAX)
        await bot.api
          .sendMessage(chatId, text, {
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
          .catch(() => {
            // If send fails, clean up and reject with "reject" so the engine keeps going.
            pendingPerms.delete(key)
            resolve("reject")
          })
      })
    }

    // multiple-choice question with inline buttons
    const askQuestion = (ask: { question: string; options: string[] }): Promise<string> => {
      return new Promise(async (resolve) => {
        const key = String(++cbSeq)
        pendingQuestions.set(key, resolve)
        const rows = ask.options
          .slice(0, 8)
          .map((label: string, i: number) => [
            { text: label.slice(0, 60), callback_data: `qa:${key}:${i}` },
          ])
        await bot.api
          .sendMessage(chatId, `❓ ${ask.question}`.slice(0, TELEGRAM_MAX), {
            reply_markup: { inline_keyboard: rows },
          })
          .catch(() => {
            pendingQuestions.delete(key)
            resolve(ask.options[0] ?? "ok")
          })
      })
    }

    // Voice reply (Phase B): Telegram voice notes need Ogg/Opus. The cloud TTS
    // returns Ogg ("OggS" magic) → sendVoice; local Piper returns WAV ("RIFF")
    // → sendAudio (still plays, just not a round voice bubble).
    const sendVoice = async (audio: Uint8Array): Promise<void> => {
      const isOgg = audio[0] === 0x4f && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53 // "OggS"
      try {
        if (isOgg) await bot.api.sendVoice(chatId, new InputFile(audio, "reply.ogg"))
        else await bot.api.sendAudio(chatId, new InputFile(audio, "reply.wav"))
      } catch (err: any) {
        await bot.api.sendMessage(chatId, `(voice reply failed: ${err?.message ?? err})`).catch(() => {})
      }
    }

    return { sendText, typing, startStatus, askPermission, askQuestion, sendVoice }
  }

  // ── ChannelAdapter implementation ─────────────────────────────────────────

  const start = async (ctx: GatewayContext): Promise<void> => {
    // Auth middleware — drop unauthorized users before any handler runs.
    bot.use(async (gramCtx: Context, next: () => Promise<void>) => {
      const id = gramCtx.from?.id?.toString()
      if (!id || !ctx.isAuthorized("telegram", id)) {
        ctx.log("telegram", `Ignored update from unauthorized id: ${id ?? "(unknown)"}`)
        return
      }
      await next()
    })

    // ── Command handlers ───────────────────────────────────────────────────

    // Helper to extract args text after the /command word.
    const argsOf = (gramCtx: Context): string => {
      const text: string = (gramCtx.message as any)?.text ?? ""
      const firstSpace = text.indexOf(" ")
      return firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim()
    }

    const handleCmd = (command: string) => async (gramCtx: Context) => {
      const chatId = gramCtx.chat!.id
      const userId = gramCtx.from!.id.toString()
      const args = argsOf(gramCtx)
      const incomingMsg: IncomingMessage = {
        conversationId: chatId.toString(),
        userId,
        text: (gramCtx.message as any)?.text ?? `/${command}`,
      }
      const responder = makeResponder(chatId, gramCtx)
      await ctx.handleCommand("telegram", command, args, incomingMsg, responder)
    }

    // Full command list the engine handles (mirrors packages/telegram + the
    // gateway's Phase C/D additions + the CLI-only stubs).
    const commands = [
      "new", "status", "stop", "model", "sessions", "s",
      "cost", "usage", "undo", "compact", "rename", "fork",
      "export", "copy", "agents", "skills", "init", "share",
      "review", "move", "thinking", "autoallow", "remote", "help", "start",
      // Phase C (cron) + Phase D (learning loop)
      "schedule", "jobs", "unschedule", "recall", "remember", "automemory",
      "personality", "insights", "compress", "voice", "curate", "profile",
      // Native MCP tools (browser, …)
      "tools", "mcps",
      // CLI-only stubs — the engine replies "CLI-only" for these
      "diff", "editor", "exit", "themes", "timeline", "timestamps", "stuntdouble", "connect",
    ] as const

    for (const cmd of commands) {
      bot.command(cmd, handleCmd(cmd))
    }

    // Register Telegram commands menu (the "/" autocomplete list).
    try {
      await bot.api.setMyCommands([
        { command: "start", description: "Welcome message" },
        { command: "new", description: "Fresh session" },
        { command: "sessions", description: "List or switch session" },
        { command: "status", description: "Current session info" },
        { command: "stop", description: "Abort running task" },
        { command: "model", description: "Show or change model" },
        { command: "cost", description: "Cost report + stunt-double savings" },
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
        { command: "schedule", description: "Schedule a task (cron)" },
        { command: "jobs", description: "List scheduled jobs" },
        { command: "unschedule", description: "Remove a scheduled job" },
        { command: "recall", description: "Search past sessions" },
        { command: "remember", description: "Save a fact to memory" },
        { command: "automemory", description: "Auto-curate memory on/off" },
        { command: "personality", description: "Set agent personality" },
        { command: "insights", description: "Usage insights" },
        { command: "voice", description: "Speak replies on/off (Piper)" },
        { command: "profile", description: "What the agent knows about you" },
        { command: "curate", description: "Archive unused auto-skills" },
        { command: "tools", description: "Enable/disable native tools (browser)" },
        { command: "help", description: "Show all commands" },
      ])
      // Clear any stale narrower scope so the default menu we just set wins in
      // private chats too. Telegram resolves the most specific scope first, so a
      // leftover all_private_chats list (e.g. an old 3-command one) would hide
      // the full default menu. Deleting it falls back to default everywhere.
      await bot.api.deleteMyCommands({ scope: { type: "all_private_chats" } }).catch(() => {})
      ctx.log("telegram", "Commands menu registered")
    } catch (err: any) {
      ctx.log("telegram", `Could not register commands menu: ${err?.message ?? err}`)
    }

    // ── Text message handler ───────────────────────────────────────────────

    bot.on("message:text", (gramCtx: Context) => {
      const text: string = (gramCtx.message as any)?.text ?? ""
      if (text.startsWith("/")) return

      // DETACHED: grammy processes updates sequentially. Awaiting the prompt
      // here would block Allow/Deny callback queries from being handled:
      //   prompt waits for permission reply → reply waits for this handler → deadlock.
      void (async () => {
        const chatId = gramCtx.chat!.id
        const userId = gramCtx.from!.id.toString()
        const incomingMsg: IncomingMessage = {
          conversationId: chatId.toString(),
          userId,
          text,
        }
        const responder = makeResponder(chatId, gramCtx)
        await ctx.handleMessage("telegram", incomingMsg, responder)
      })()
    })

    // ── Voice / audio handler (Phase B) ─────────────────────────────────────
    bot.on(["message:voice", "message:audio"], (gramCtx: Context) => {
      if (!ctx.transcribe) {
        void gramCtx.reply("🎤 Voice received, but transcription isn't configured. Set config.voice.").catch(() => {})
        return
      }
      void (async () => {
        const chatId = gramCtx.chat!.id
        const userId = gramCtx.from!.id.toString()
        try {
          const file = await gramCtx.getFile() // works for voice + audio
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
          const buf = new Uint8Array(await (await fetch(url)).arrayBuffer())
          const text = await ctx.transcribe!(buf, "voice.ogg")
          if (!text) {
            await gramCtx.reply("🎤 Couldn't transcribe that audio.").catch(() => {})
            return
          }
          await gramCtx.reply(`🎤 "${text}"`).catch(() => {})
          const incomingMsg: IncomingMessage = { conversationId: chatId.toString(), userId, text, audio: true }
          const responder = makeResponder(chatId, gramCtx)
          if (text.startsWith("/")) {
            const sp = text.indexOf(" ")
            const command = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase()
            const args = sp === -1 ? "" : text.slice(sp + 1).trim()
            await ctx.handleCommand("telegram", command, args, incomingMsg, responder)
          } else {
            await ctx.handleMessage("telegram", incomingMsg, responder)
          }
        } catch (err: any) {
          ctx.log("telegram", `voice handling failed: ${err?.message ?? err}`)
          await gramCtx.reply("🎤 Voice transcription failed.").catch(() => {})
        }
      })()
    })

    bot.catch((err) => {
      console.error("TelegramAdapter bot error:", err.message)
    })

    // bot.start() never resolves until stopped — run detached so start() returns.
    bot.start({
      onStart: (info) =>
        ctx.log("telegram", `Bot online as @${info.username}`),
    })
  }

  const stop = async (): Promise<void> => {
    await bot.stop()
  }

  const deliver = async (conversationId: string, text: string): Promise<void> => {
    for (let i = 0; i < text.length; i += TELEGRAM_MAX) {
      await bot.api.sendMessage(conversationId, text.slice(i, i + TELEGRAM_MAX)).catch(() => {})
    }
  }

  return {
    id: "telegram",
    label: "Telegram",
    start,
    stop,
    deliver,
  }
}

/**
 * Create a TelegramAdapter from a token.
 *
 * Usage in the gateway:
 *   const adapter = createTelegramAdapter({ token: channelConfig.token! })
 *   await adapter.start(gatewayCtx)
 */
export function createTelegramAdapter(opts: { token: string }): ChannelAdapter {
  return makeTelegramAdapter(opts.token)
}

/**
 * AdapterFactory integration — lets the gateway instantiate from a ChannelConfig
 * block without knowing the adapter's constructor signature.
 *
 * Usage:
 *   import { telegramAdapterFactory } from "./adapters/telegram"
 *   const adapter = telegramAdapterFactory.create(channelConfig)
 */
export const telegramAdapterFactory = {
  id: "telegram" as const,
  label: "Telegram" as const,
  create(config: import("../types").ChannelConfig): ChannelAdapter | undefined {
    if (!config.token) return undefined
    return makeTelegramAdapter(config.token)
  },
}
