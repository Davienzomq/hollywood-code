import { Bot, InputFile, type Context } from "grammy"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChannelAdapter, GatewayContext, Responder, StatusHandle, IncomingMessage } from "../types"

const TELEGRAM_MAX = 4096

// ── Lightweight markdown → Telegram HTML ─────────────────────────────────────
// Agent replies are full of ``` blocks, `code` and **bold** that used to arrive
// as raw markdown. Convert conservatively PER CHUNK: escape everything first,
// then re-introduce only the tags we can guarantee are balanced; if anything
// looks unbalanced, return undefined and the caller sends plain text. A failed
// HTML send also falls back to plain, so formatting can never lose a message.
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
function mdToTelegramHtml(chunk: string): string | undefined {
  const hasMarkers = /```|`[^`\n]+`|\*\*[^*\n]+\*\*/.test(chunk)
  if (!hasMarkers) return undefined
  if (((chunk.match(/```/g) ?? []).length) % 2 !== 0) return undefined // split fence → plain
  let out = escHtml(chunk)
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => `<pre>${code}</pre>`)
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => `<b>${b}</b>`)
  return out
}

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
    // sendText: chunk at 4096 chars; try formatted HTML per chunk, fall back to
    // plain on any parse rejection so a message is never lost to formatting.
    const sendText = async (text: string): Promise<void> => {
      if (!text) return
      for (let i = 0; i < text.length; i += TELEGRAM_MAX) {
        const chunk = text.slice(i, i + TELEGRAM_MAX)
        const html = mdToTelegramHtml(chunk)
        if (html && html.length <= TELEGRAM_MAX) {
          try {
            await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" })
            continue
          } catch {
            /* fall through to plain */
          }
        }
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
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const settle = (val: "once" | "always" | "reject") => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          pendingPerms.delete(key)
          resolve(val)
        }
        pendingPerms.set(key, settle)
        // Questions auto-cancel after 3 min but permissions never did — an
        // unanswered request left a pending promise + map entry forever. Deny
        // after 10 min (safe default; the agent proceeds without the action).
        timer = setTimeout(() => settle("reject"), 10 * 60 * 1000)
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
          .catch(() => settle("reject"))
      })
    }

    // multiple-choice question with inline buttons
    const askQuestion = (ask: { question: string; options: string[] }): Promise<string> => {
      return new Promise(async (resolve) => {
        const key = String(++cbSeq)
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        // Single resolution path (idempotent). Resolving "" means "no choice" —
        // every caller treats an empty/unmatched answer as a no-op.
        const settle = (val: string) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          pendingQuestions.delete(key)
          resolve(val)
        }
        pendingQuestions.set(key, settle)
        // Telegram allows up to 100 inline buttons; the old cap of 8 HID options
        // (e.g. OpenAI's model list overflows 8 — the rest were unpickable).
        const rows = ask.options
          .slice(0, 30)
          .map((label: string, i: number) => [
            { text: label.slice(0, 60), callback_data: `qa:${key}:${i}` },
          ])
        // Safety net: this picker is awaited inline and the update queue is
        // sequential, so an unanswered question would freeze the whole bot.
        // Auto-cancel (no choice) after 3 min so the bot always recovers.
        timer = setTimeout(() => settle(""), 3 * 60 * 1000)
        await bot.api
          .sendMessage(chatId, `❓ ${ask.question}`.slice(0, TELEGRAM_MAX), {
            reply_markup: { inline_keyboard: rows },
          })
          .catch(() => settle(""))
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

    // File attachment (long transcripts etc.) — falls back to text on failure.
    const sendFile = async (data: Uint8Array, filename: string, caption?: string): Promise<void> => {
      try {
        await bot.api.sendDocument(chatId, new InputFile(data, filename), caption ? { caption: caption.slice(0, 1024) } : undefined)
      } catch (err: any) {
        await bot.api.sendMessage(chatId, `(file send failed: ${err?.message ?? err})`).catch(() => {})
      }
    }

    return { sendText, typing, startStatus, askPermission, askQuestion, sendVoice, sendFile }
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

    const handleCmd = (command: string) => (gramCtx: Context) => {
      // DETACHED (same reason as the message:text handler below): commands like
      // /model, /sessions and /move open an inline-keyboard question and AWAIT the
      // tap. grammy processes updates sequentially, so awaiting here would block
      // the update loop from ever delivering that tap → the question never
      // resolves and the whole bot freezes. Run detached so the loop stays free.
      void (async () => {
        const chatId = gramCtx.chat!.id
        const userId = gramCtx.from!.id.toString()
        const args = argsOf(gramCtx)
        const incomingMsg: IncomingMessage = {
          conversationId: chatId.toString(),
          userId,
          text: (gramCtx.message as any)?.text ?? `/${command}`,
        }
        const responder = makeResponder(chatId, gramCtx)
        // A thrown command must never crash the whole gateway (an unhandled
        // rejection in this detached task would kill the process and freeze the
        // bot). Catch, report to the user, and keep the bot alive.
        try {
          await ctx.handleCommand("telegram", command, args, incomingMsg, responder)
        } catch (err: any) {
          try { await responder.sendText(`⚠️ /${command} failed: ${err?.message ?? err}`) } catch { /* ignore */ }
        }
      })()
    }

    // Full command list the engine handles (mirrors packages/telegram + the
    // gateway's Phase C/D additions + the CLI-only stubs).
    const commands = [
      "new", "clear", "status", "stop", "model", "session", "sessions", "s",
      "cost", "usage", "undo", "compact", "rename", "fork",
      "export", "copy", "agents", "skills", "init", "share",
      "review", "move", "thinking", "autoallow", "remote", "help", "start",
      // Phase C (cron) + Phase D (learning loop)
      "schedule", "jobs", "unschedule", "recall", "remember", "automemory", "memory",
      "personality", "insights", "compress", "voice", "curate", "profile",
      // Native MCP tools (browser, …)
      "tools", "mcps",
      // New commands (v2)
      "unshare", "redo", "variants", "autostart", "org",
      // CLI-only stubs — the engine replies "CLI-only" for these
      "diff", "editor", "exit", "themes", "timeline", "timestamps", "stuntdouble", "connect",
      // Diagnostic / context commands
      "doctor", "rewind", "permissions", "context",
      // v3 utility commands
      "debug", "goal", "loop", "autocompact", "mode", "effort", "mix",
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
        { command: "thinking", description: "Reasoning effort (alias of /effort)" },
        { command: "autoallow", description: "Auto-approve on/off" },
        { command: "remote", description: "Connection status" },
        { command: "schedule", description: "Schedule a task (cron)" },
        { command: "jobs", description: "List scheduled jobs" },
        { command: "unschedule", description: "Remove a scheduled job" },
        { command: "recall", description: "Search past sessions" },
        { command: "remember", description: "Save a fact to memory" },
        { command: "automemory", description: "Auto-curate memory on/off" },
        { command: "memory", description: "Memory status / search / curate" },
        { command: "personality", description: "Set agent personality" },
        { command: "insights", description: "Usage insights" },
        { command: "voice", description: "Speak replies on/off (Piper)" },
        { command: "profile", description: "What the agent knows about you" },
        { command: "curate", description: "Archive unused auto-skills" },
        { command: "tools", description: "Enable/disable native tools (browser)" },
        { command: "unshare", description: "Stop sharing the active session" },
        { command: "redo", description: "Redo a previously undone revert" },
        { command: "variants", description: "Switch model variant" },
        { command: "autostart", description: "Manage OS auto-start (on/off/status)" },
        { command: "org", description: "Switch active Console organization" },
        { command: "clear", description: "Fresh session (alias of /new)" },
        { command: "debug", description: "Toggle verbose logging (on|off)" },
        { command: "goal", description: "Set/show/clear a per-session goal" },
        { command: "loop", description: "Run a prompt on an interval; /loop stop to cancel" },
        { command: "help", description: "Show all commands" },
        { command: "doctor", description: "Diagnose install (checks bins, auth, server)" },
        { command: "rewind", description: "Roll back to a past user message" },
        { command: "permissions", description: "View/edit per-tool permission rules" },
        { command: "context", description: "Show context-window token usage" },
        { command: "autocompact", description: "Auto-compact threshold (default 95%) / on|off" },
        { command: "mode", description: "Permission mode: ask|auto-edit|plan|bypass|auto" },
        { command: "effort", description: "Reasoning effort / model variant (e.g. high|max)" },
        { command: "mix", description: "Cross-provider auto-router (on|off|set tiers)" },
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
      if (text.startsWith("/")) {
        // Registered commands were already handled by bot.command() middleware
        // (which ends the chain) — reaching here means the command is UNKNOWN.
        // It used to die silently; now the user gets a pointer instead of limbo.
        const word = text.slice(1).split(/[\s@]/, 1)[0] ?? ""
        void gramCtx.reply(`❓ Unknown command /${word} — see /help for the full list.`).catch(() => {})
        return
      }

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
        try {
          await ctx.handleMessage("telegram", incomingMsg, responder)
        } catch (err: any) {
          try { await responder.sendText(`⚠️ Error: ${err?.message ?? err}`) } catch { /* ignore */ }
        }
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
        // Immediate feedback: local whisper can take several seconds and the
        // user used to stare at nothing. The note is edited into the transcript.
        const note = await gramCtx.reply("🎤 Transcribing…").catch(() => undefined)
        try {
          const file = await gramCtx.getFile() // works for voice + audio
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
          const buf = new Uint8Array(await (await fetch(url)).arrayBuffer())
          const text = await ctx.transcribe!(buf, "voice.ogg")
          if (!text) {
            if (note) await bot.api.editMessageText(chatId, note.message_id, "🎤 Couldn't transcribe that audio.").catch(() => {})
            else await gramCtx.reply("🎤 Couldn't transcribe that audio.").catch(() => {})
            return
          }
          if (note) await bot.api.editMessageText(chatId, note.message_id, `🎤 "${text}"`.slice(0, TELEGRAM_MAX)).catch(() => {})
          else await gramCtx.reply(`🎤 "${text}"`).catch(() => {})
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

    // ── Photo / image handler ───────────────────────────────────────────────
    // Forward images to the model as data-URL file parts so vision-capable
    // models can see them (the engine warns if the active model has no vision).
    bot.on(["message:photo", "message:document"], (gramCtx: Context) => {
      const m = gramCtx.message as any
      const photos = m?.photo as Array<{ file_id: string }> | undefined
      const doc = m?.document as { file_id: string; mime_type?: string; file_name?: string; file_size?: number } | undefined
      const isImageDoc = !!doc && typeof doc.mime_type === "string" && doc.mime_type.startsWith("image/")

      // TEXT documents (PRD.md, .txt, code files…) used to be ignored in total
      // silence — the user sent a file and nothing happened. Inline them into
      // the prompt so the agent can read them directly.
      const TEXT_EXT = /\.(md|txt|json|jsonc|yaml|yml|csv|log|ts|tsx|js|jsx|py|go|rs|java|rb|sh|ps1|css|html|xml|sql|toml|ini|env)$/i
      const isTextDoc =
        !!doc &&
        !isImageDoc &&
        ((typeof doc.mime_type === "string" && (doc.mime_type.startsWith("text/") || doc.mime_type === "application/json")) ||
          TEXT_EXT.test(doc.file_name ?? ""))
      if (isTextDoc) {
        void (async () => {
          const chatId = gramCtx.chat!.id
          const userId = gramCtx.from!.id.toString()
          const responder = makeResponder(chatId, gramCtx)
          try {
            const MAX_TEXT_DOC = 256 * 1024
            if ((doc!.file_size ?? 0) > MAX_TEXT_DOC) {
              await responder.sendText(`⚠️ ${doc!.file_name ?? "File"} is too large to inline (max 256 KB). Put it in the project and ask me to read it.`)
              return
            }
            const file = await gramCtx.api.getFile(doc!.file_id)
            const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
            const content = Buffer.from(await (await fetch(url)).arrayBuffer()).toString("utf8")
            const caption: string = m?.caption ?? ""
            const name = doc!.file_name ?? "file.txt"
            const text = `${caption || `I'm sending you the file ${name} — read it.`}\n\n📎 ${name}:\n\`\`\`\n${content}\n\`\`\``
            await ctx.handleMessage("telegram", { conversationId: chatId.toString(), userId, text }, responder)
          } catch (err: any) {
            ctx.log("telegram", `text-doc handling failed: ${err?.message ?? err}`)
            try { await responder.sendText(`⚠️ Couldn't read that file: ${err?.message ?? err}`) } catch { /* ignore */ }
          }
        })()
        return
      }

      if (!photos?.length && !isImageDoc) {
        // Unsupported document type — say so instead of dying silently.
        void gramCtx.reply("📎 I can read images and text files (.md, .txt, code). This file type isn't supported yet.").catch(() => {})
        return
      }

      void (async () => {
        const chatId = gramCtx.chat!.id
        const userId = gramCtx.from!.id.toString()
        const caption: string = m?.caption ?? ""
        const responder = makeResponder(chatId, gramCtx)
        try {
          let mime = "image/jpeg"
          let filename = "photo.jpg"
          let fileId: string
          if (photos?.length) {
            fileId = photos[photos.length - 1]!.file_id // largest size
          } else {
            fileId = doc!.file_id
            mime = doc!.mime_type!
            filename = doc!.file_name ?? "image"
          }
          const file = await gramCtx.api.getFile(fileId)
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
          const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
          const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
          const incomingMsg: IncomingMessage = {
            conversationId: chatId.toString(),
            userId,
            text: caption,
            images: [{ url: dataUrl, mime, filename }],
          }
          await ctx.handleMessage("telegram", incomingMsg, responder)
        } catch (err: any) {
          ctx.log("telegram", `image handling failed: ${err?.message ?? err}`)
          try { await responder.sendText(`⚠️ Couldn't read that image: ${err?.message ?? err}`) } catch { /* ignore */ }
        }
      })()
    })

    // ── Video / animation handler ───────────────────────────────────────────
    // Download the clip to a temp file; the engine samples frames (ffmpeg) and
    // sends them to a vision model, or warns if it can't.
    bot.on(["message:video", "message:animation"], (gramCtx: Context) => {
      const m = gramCtx.message as any
      const vid = (m?.video ?? m?.animation) as { file_id: string; file_name?: string; mime_type?: string } | undefined
      if (!vid?.file_id) return
      void (async () => {
        const chatId = gramCtx.chat!.id
        const userId = gramCtx.from!.id.toString()
        const caption: string = m?.caption ?? ""
        const responder = makeResponder(chatId, gramCtx)
        let tmpPath: string | undefined
        try {
          const file = await gramCtx.api.getFile(vid.file_id)
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
          const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
          const ext = (vid.file_name?.match(/\.[a-z0-9]+$/i)?.[0] || ".mp4").toLowerCase()
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "holly-tg-vid-"))
          tmpPath = path.join(dir, `video${ext}`)
          fs.writeFileSync(tmpPath, buf)
          const incomingMsg: IncomingMessage = {
            conversationId: chatId.toString(),
            userId,
            text: caption,
            videos: [{ path: tmpPath, filename: vid.file_name ?? "video" }],
          }
          await ctx.handleMessage("telegram", incomingMsg, responder)
        } catch (err: any) {
          ctx.log("telegram", `video handling failed: ${err?.message ?? err}`)
          try { await responder.sendText(`⚠️ Couldn't read that video: ${err?.message ?? err}`) } catch { /* ignore */ }
          if (tmpPath) try { fs.rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
        }
      })()
    })

    bot.catch((err) => {
      console.error("TelegramAdapter bot error:", err.message)
    })

    // bot.start() never resolves until stopped — run detached so start() returns.
    // drop_pending_updates: after downtime the bot used to replay the queued
    // backlog and answer stale messages; start fresh instead.
    bot.start({
      drop_pending_updates: true,
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

  // Outbound voice: cloud TTS → Ogg ("OggS") → sendVoice; local Piper → WAV
  // ("RIFF") → sendAudio. Mirrors the per-message sendVoice responder.
  const deliverVoice = async (conversationId: string, audio: Uint8Array): Promise<void> => {
    const isOgg = audio[0] === 0x4f && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53
    try {
      if (isOgg) await bot.api.sendVoice(conversationId, new InputFile(audio, "reply.ogg"))
      else await bot.api.sendAudio(conversationId, new InputFile(audio, "reply.wav"))
    } catch {
      /* best-effort */
    }
  }

  return {
    id: "telegram",
    label: "Telegram",
    start,
    stop,
    deliver,
    deliverVoice,
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
