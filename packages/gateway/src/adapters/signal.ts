import type {
  ChannelAdapter,
  ChannelConfig,
  GatewayContext,
  Responder,
  StatusHandle,
  IncomingMessage,
} from "../types"

// Signal has no official bot API. The standard approach is the
// bbernhard/signal-cli-rest-api Docker container, which exposes a simple HTTP
// API. This adapter talks to it via fetch (no npm lib). Set up with:
//   docker run -p 8080:8080 -v $HOME/.local/share/signal-cli:/home/.local/share/signal-cli
//     -e MODE=json-rpc bbernhard/signal-cli-rest-api
// then register/link the bot number once via that API.

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

interface SignalExtra {
  apiUrl: string
  number: string
}

function extractExtra(extra: Record<string, unknown>): SignalExtra | null {
  const { apiUrl, number } = extra
  if (typeof apiUrl !== "string" || typeof number !== "string") return null
  return { apiUrl: apiUrl.replace(/\/$/, ""), number }
}

function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("/")) return null
  const sp = trimmed.indexOf(" ")
  if (sp === -1) return { command: trimmed.slice(1).toLowerCase(), args: "" }
  return { command: trimmed.slice(1, sp).toLowerCase(), args: trimmed.slice(sp + 1).trim() }
}

const SIGNAL_MAX = 2000

function makeSignalAdapter(cfg: ChannelConfig, extra: SignalExtra): ChannelAdapter {
  const allowed = new Set(cfg.allowedIds)
  const pendingReplies = new Map<string, PendingReply>()
  let pollInterval: ReturnType<typeof setInterval> | null = null

  const send = async (recipient: string, message: string, ctx?: GatewayContext) => {
    try {
      await fetch(`${extra.apiUrl}/v2/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, number: extra.number, recipients: [recipient] }),
      })
    } catch (err: any) {
      ctx?.log("signal", `send failed to ${recipient}: ${err?.message ?? err}`)
    }
  }

  function makeResponder(to: string, ctx: GatewayContext): Responder {
    const sendText = async (text: string): Promise<void> => {
      if (!text) return
      for (let i = 0; i < text.length; i += SIGNAL_MAX) {
        await send(to, text.slice(i, i + SIGNAL_MAX), ctx)
      }
    }
    const typing = async (): Promise<void> => {
      try {
        await fetch(`${extra.apiUrl}/v1/typing-indicator/${encodeURIComponent(extra.number)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipient: to }),
        })
      } catch {
        /* best-effort */
      }
    }
    // Signal (via this API) has no message editing — status pings would spam.
    const startStatus = async (_initial: string): Promise<StatusHandle> => ({
      update: async () => {},
      finalize: async () => {},
    })
    const askPermission = (ask: { action: string; detail: string }) =>
      new Promise<"once" | "always" | "reject">((resolve) => {
        const timer = setTimeout(() => {
          pendingReplies.delete(to)
          resolve("reject")
        }, 600_000)
        pendingReplies.set(to, { kind: "permission", resolve, timer })
        void sendText(
          `🔐 Permission needed: ${ask.action} — ${ask.detail}\n` +
            `Reply ALLOW, ALWAYS, or DENY.`,
        )
      })
    const askQuestion = (ask: { question: string; options: string[] }) =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          pendingReplies.delete(to)
          resolve(ask.options[0] ?? "ok")
        }, 600_000)
        pendingReplies.set(to, { kind: "question", options: ask.options, resolve, timer })
        const numbered = ask.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")
        void sendText(`❓ ${ask.question}\n${numbered}\nReply with the number.`)
      })
    return { sendText, typing, startStatus, askPermission, askQuestion }
  }

  function tryResolvePending(sender: string, body: string): boolean {
    const pending = pendingReplies.get(sender)
    if (!pending) return false
    const first = body.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
    if (pending.kind === "permission") {
      let decision: "once" | "always" | "reject"
      if (first === "allow") decision = "once"
      else if (first === "always") decision = "always"
      else if (first === "deny") decision = "reject"
      else return false
      clearTimeout(pending.timer)
      pendingReplies.delete(sender)
      pending.resolve(decision)
      return true
    }
    const idx = parseInt(first, 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= pending.options.length) return false
    clearTimeout(pending.timer)
    pendingReplies.delete(sender)
    pending.resolve(pending.options[idx]!)
    return true
  }

  async function poll(ctx: GatewayContext): Promise<void> {
    try {
      const res = await fetch(`${extra.apiUrl}/v1/receive/${encodeURIComponent(extra.number)}`)
      if (!res.ok) return
      const messages: any[] = await res.json().catch(() => [])
      for (const m of messages) {
        const env = m?.envelope ?? {}
        const sender: string = env.source ?? env.sourceNumber ?? ""
        const text: string = env.dataMessage?.message ?? ""
        if (!sender || !text) continue
        if (tryResolvePending(sender, text)) continue
        if (!allowed.has(sender)) {
          ctx.log("signal", `Ignored message from unauthorized sender: ${sender}`)
          continue
        }
        const incoming: IncomingMessage = { conversationId: sender, userId: sender, text }
        const responder = makeResponder(sender, ctx)
        void (async () => {
          try {
            const parsed = parseCommand(text)
            if (parsed) await ctx.handleCommand("signal", parsed.command, parsed.args, incoming, responder)
            else await ctx.handleMessage("signal", incoming, responder)
          } catch (err: any) {
            ctx.log("signal", `handler error for ${sender}: ${err?.message ?? err}`)
          }
        })()
      }
    } catch (err: any) {
      ctx.log("signal", `poll error: ${err?.message ?? err}`)
    }
  }

  const start = async (ctx: GatewayContext): Promise<void> => {
    void poll(ctx)
    pollInterval = setInterval(() => void poll(ctx), 3000)
    ctx.log("signal", `Signal adapter started (${extra.apiUrl}, polling every 3 s)`)
  }
  const stop = async (): Promise<void> => {
    if (pollInterval) clearInterval(pollInterval)
    pollInterval = null
    for (const [, p] of pendingReplies) clearTimeout(p.timer)
    pendingReplies.clear()
  }

  const deliver = async (conversationId: string, text: string): Promise<void> => {
    for (let i = 0; i < text.length; i += SIGNAL_MAX) await send(conversationId, text.slice(i, i + SIGNAL_MAX))
  }

  return { id: "signal", label: "Signal", start, stop, deliver }
}

/**
 * Required cfg.extra: { apiUrl (e.g. "http://127.0.0.1:8080"), number ("+15551234567") }.
 * cfg.allowedIds = allowlisted sender numbers. Returns undefined if incomplete.
 */
export function createSignalAdapter(cfg: ChannelConfig): ChannelAdapter | undefined {
  if (!cfg.extra) return undefined
  const extra = extractExtra(cfg.extra)
  if (!extra) return undefined
  return makeSignalAdapter(cfg, extra)
}
