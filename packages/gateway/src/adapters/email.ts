import { ImapFlow } from "imapflow"
import nodemailer from "nodemailer"
import type {
  ChannelAdapter,
  ChannelConfig,
  GatewayContext,
  Responder,
  StatusHandle,
  IncomingMessage,
} from "../types"

// ─── Pending-reply resolver types ────────────────────────────────────────────

interface PendingPermission {
  kind: "permission"
  resolve: (decision: "once" | "always" | "reject") => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingQuestion {
  kind: "question"
  options: string[]
  resolve: (chosen: string) => void
  timer: ReturnType<typeof setTimeout>
}

type PendingReply = PendingPermission | PendingQuestion

// ─── Strip quoted reply lines (lines starting with ">") ──────────────────────

function stripQuotedReplies(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim()
}

// ─── Parse first token to detect a command ───────────────────────────────────

function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("/")) return null
  const firstSpace = trimmed.indexOf(" ")
  if (firstSpace === -1) {
    return { command: trimmed.slice(1).toLowerCase(), args: "" }
  }
  return {
    command: trimmed.slice(1, firstSpace).toLowerCase(),
    args: trimmed.slice(firstSpace + 1).trim(),
  }
}

// ─── Required extra fields ────────────────────────────────────────────────────

interface EmailExtra {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  user: string
  pass: string
  secure?: boolean
}

function extractExtra(extra: Record<string, unknown>): EmailExtra | null {
  const { imapHost, imapPort, smtpHost, smtpPort, user, pass, secure } = extra
  if (
    typeof imapHost !== "string" ||
    typeof smtpHost !== "string" ||
    typeof user !== "string" ||
    typeof pass !== "string"
  ) {
    return null
  }
  return {
    imapHost,
    imapPort: typeof imapPort === "number" ? imapPort : 993,
    smtpHost,
    smtpPort: typeof smtpPort === "number" ? smtpPort : 587,
    user,
    pass,
    secure: typeof secure === "boolean" ? secure : true,
  }
}

// ─── Adapter factory ──────────────────────────────────────────────────────────

function makeEmailAdapter(cfg: ChannelConfig, extra: EmailExtra): ChannelAdapter {
  const allowedIds = cfg.allowedIds.map((id) => id.toLowerCase())

  // Pending reply resolvers keyed by sender email (lowercased).
  const pendingReplies = new Map<string, PendingReply>()

  // NodeMailer transporter — created once, reused.
  const transporter = nodemailer.createTransport({
    host: extra.smtpHost,
    port: extra.smtpPort,
    secure: extra.secure,
    auth: { user: extra.user, pass: extra.pass },
  })

  // IMAP client — recreated on each start().
  let imap: ImapFlow | null = null
  let pollInterval: ReturnType<typeof setInterval> | null = null

  // ── Responder factory ───────────────────────────────────────────────────────

  function makeResponder(
    to: string,
    originalSubject: string,
    inReplyTo?: string,
    ctx?: GatewayContext,
  ): Responder {
    const replySubject = originalSubject.toLowerCase().startsWith("re:")
      ? originalSubject
      : `Re: ${originalSubject}`

    const sendText = async (text: string): Promise<void> => {
      if (!text) return
      try {
        await transporter.sendMail({
          from: extra.user,
          to,
          subject: replySubject,
          text,
          ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
        })
      } catch (err: any) {
        ctx?.log("email", `sendText failed to ${to}: ${err?.message ?? err}`)
      }
    }

    const typing = async (): Promise<void> => {
      // Email has no typing indicator — no-op.
    }

    const startStatus = async (_initial: string): Promise<StatusHandle> => {
      // Email is asynchronous; status pings would spam the inbox.
      // update() and finalize() are no-ops; the final sendText carries the label.
      const update = async (_text: string): Promise<void> => {}
      const finalize = async (_label: string): Promise<void> => {}
      return { update, finalize }
    }

    const askPermission = (ask: {
      action: string
      detail: string
    }): Promise<"once" | "always" | "reject"> => {
      return new Promise<"once" | "always" | "reject">((resolve) => {
        const body =
          `Permission needed: ${ask.action} — ${ask.detail}\n\n` +
          `Reply with one of the following (just the word, nothing else):\n` +
          `  ALLOW   — allow this one time\n` +
          `  ALWAYS  — always allow this action\n` +
          `  DENY    — deny this request`

        const timer = setTimeout(() => {
          pendingReplies.delete(to)
          resolve("reject")
        }, 10 * 60 * 1000) // 10 minutes

        pendingReplies.set(to, { kind: "permission", resolve, timer })

        sendText(body).catch((err: any) => {
          ctx?.log("email", `askPermission send failed to ${to}: ${err?.message ?? err}`)
        })
      })
    }

    const askQuestion = (ask: {
      question: string
      options: string[]
    }): Promise<string> => {
      return new Promise<string>((resolve) => {
        const numbered = ask.options.map((opt, i) => `  ${i + 1}. ${opt}`).join("\n")
        const body =
          `${ask.question}\n\n${numbered}\n\n` +
          `Reply with just the number of your choice.`

        const timer = setTimeout(() => {
          pendingReplies.delete(to)
          resolve(ask.options[0] ?? "ok")
        }, 10 * 60 * 1000) // 10 minutes

        pendingReplies.set(to, {
          kind: "question",
          options: ask.options,
          resolve,
          timer,
        })

        sendText(body).catch((err: any) => {
          ctx?.log("email", `askQuestion send failed to ${to}: ${err?.message ?? err}`)
        })
      })
    }

    return { sendText, typing, startStatus, askPermission, askQuestion }
  }

  // ── Resolve a pending reply (permission or question) ─────────────────────────

  function tryResolvePending(sender: string, bodyText: string): boolean {
    const pending = pendingReplies.get(sender)
    if (!pending) return false

    const first = bodyText.trim().split(/\s+/)[0]?.toLowerCase() ?? ""

    if (pending.kind === "permission") {
      let decision: "once" | "always" | "reject" = "reject"
      if (first === "allow") decision = "once"
      else if (first === "always") decision = "always"
      else if (first === "deny") decision = "reject"
      else return false // Not a valid answer — treat as new message.
      clearTimeout(pending.timer)
      pendingReplies.delete(sender)
      pending.resolve(decision)
      return true
    }

    if (pending.kind === "question") {
      const idx = parseInt(first, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= pending.options.length) return false
      clearTimeout(pending.timer)
      pendingReplies.delete(sender)
      pending.resolve(pending.options[idx]!)
      return true
    }

    return false
  }

  // ── IMAP poll: fetch UNSEEN messages and dispatch ────────────────────────────

  async function poll(ctx: GatewayContext): Promise<void> {
    if (!imap) return
    try {
      // Select INBOX — lock it while we work.
      await imap.mailboxOpen("INBOX")

      // Search for all UNSEEN messages.
      const uids: number[] = []
      for await (const msg of imap.fetch({ seen: false }, { uid: true })) {
        uids.push((msg as any).uid as number)
      }

      if (uids.length === 0) return

      // Fetch full envelopes + plain-text bodies.
      for await (const msg of imap.fetch(
        uids as any,
        { envelope: true, bodyStructure: true, bodyParts: ["text"] },
        { uid: true },
      )) {
        const uid: number = (msg as any).uid
        const envelope: any = (msg as any).envelope ?? {}

        // Sender address.
        const fromAddr: string =
          (envelope.from?.[0]?.address ?? "").toLowerCase()
        if (!fromAddr) {
          // Can't determine sender — mark seen and skip.
          await imap.messageFlagsAdd({ uid } as any, ["\\Seen"], { uid: true }).catch(() => {})
          continue
        }

        // Plain-text body.
        const rawBody: string =
          (msg as any).bodyParts?.get("text")?.toString("utf8") ?? ""
        const body = stripQuotedReplies(rawBody)
        const subject: string = envelope.subject ?? ""
        const messageId: string = envelope.messageId ?? ""
        const fullText = subject ? `${subject}\n${body}` : body

        // ── Check if this is an answer to a pending permission/question ask ──
        if (tryResolvePending(fromAddr, body)) {
          await imap.messageFlagsAdd({ uid } as any, ["\\Seen"], { uid: true }).catch(() => {})
          continue
        }

        // ── Authorization check ──────────────────────────────────────────────
        if (!ctx.isAuthorized("email", fromAddr)) {
          ctx.log("email", `Ignored message from unauthorized sender: ${fromAddr}`)
          // Mark seen so we don't keep re-processing it.
          await imap.messageFlagsAdd({ uid } as any, ["\\Seen"], { uid: true }).catch(() => {})
          continue
        }

        // Build IncomingMessage.
        const incomingMsg: IncomingMessage = {
          conversationId: fromAddr,
          userId: fromAddr,
          text: fullText,
        }

        const responder = makeResponder(fromAddr, subject || "Hollycode", messageId || undefined, ctx)

        // Mark seen before dispatching (detached) so a slow task doesn't cause
        // the same email to be processed twice on the next poll tick.
        await imap.messageFlagsAdd({ uid } as any, ["\\Seen"], { uid: true }).catch(() => {})

        // ── Command or message routing (detached — same reason as Telegram) ──
        void (async () => {
          try {
            const parsed = parseCommand(fullText)
            if (parsed) {
              await ctx.handleCommand("email", parsed.command, parsed.args, incomingMsg, responder)
            } else {
              await ctx.handleMessage("email", incomingMsg, responder)
            }
          } catch (err: any) {
            ctx.log("email", `Handler error for ${fromAddr}: ${err?.message ?? err}`)
          }
        })()
      }
    } catch (err: any) {
      ctx.log("email", `IMAP poll error: ${err?.message ?? err}`)
    }
  }

  // ── ChannelAdapter implementation ─────────────────────────────────────────

  const start = async (ctx: GatewayContext): Promise<void> => {
    imap = new ImapFlow({
      host: extra.imapHost,
      port: extra.imapPort,
      secure: extra.secure,
      auth: { user: extra.user, pass: extra.pass },
      // Suppress imapflow's own console logging — we route through ctx.log.
      logger: false,
    } as any)

    try {
      await imap.connect()
      ctx.log("email", `IMAP connected to ${extra.imapHost}`)
    } catch (err: any) {
      ctx.log("email", `IMAP connect failed: ${err?.message ?? err}`)
      imap = null
      return
    }

    // Initial poll immediately, then every 15 seconds.
    void poll(ctx)
    pollInterval = setInterval(() => void poll(ctx), 15_000)

    ctx.log("email", "Email adapter started (polling every 15 s)")
  }

  const stop = async (): Promise<void> => {
    if (pollInterval !== null) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    // Cancel all pending timers so they don't fire after stop.
    for (const [, pending] of pendingReplies) {
      clearTimeout(pending.timer)
    }
    pendingReplies.clear()

    if (imap) {
      try {
        await imap.logout()
      } catch {
        // Best-effort logout.
      }
      imap = null
    }
  }

  return {
    id: "email",
    label: "Email",
    start,
    stop,
  }
}

// ─── Public factory ────────────────────────────────────────────────────────────

/**
 * Create an EmailAdapter from a ChannelConfig block.
 *
 * Required `cfg.extra` fields:
 *   imapHost  string   — IMAP server hostname
 *   imapPort  number   — IMAP port (default 993)
 *   smtpHost  string   — SMTP server hostname
 *   smtpPort  number   — SMTP port (default 587)
 *   user      string   — mailbox login / from address
 *   pass      string   — mailbox password or app password
 *   secure?   boolean  — use TLS (default true)
 *
 * `cfg.allowedIds` — allowlisted sender email addresses (lowercased compare).
 *
 * Returns undefined if any required `extra` field is missing.
 *
 * Usage in gateway setup:
 *   import { createEmailAdapter } from "./adapters/email"
 *   const adapter = createEmailAdapter(channelConfig)
 *   if (adapter) await adapter.start(gatewayCtx)
 */
export function createEmailAdapter(cfg: ChannelConfig): ChannelAdapter | undefined {
  if (!cfg.extra) return undefined
  const extra = extractExtra(cfg.extra)
  if (!extra) return undefined
  return makeEmailAdapter(cfg, extra)
}

/**
 * AdapterFactory integration — lets the gateway instantiate from a ChannelConfig
 * block without knowing the adapter's constructor signature.
 *
 * Usage:
 *   import { emailAdapterFactory } from "./adapters/email"
 *   const adapter = emailAdapterFactory.create(channelConfig)
 */
export const emailAdapterFactory = {
  id: "email" as const,
  label: "Email" as const,
  create(config: ChannelConfig): ChannelAdapter | undefined {
    return createEmailAdapter(config)
  },
}
