import http from "node:http"
import type {
  ChannelAdapter,
  ChannelConfig,
  GatewayContext,
  Responder,
  StatusHandle,
  IncomingMessage,
} from "../types"

// WhatsApp Cloud API (Meta Graph) — official, no ban risk. Sending is via the
// Graph API; receiving needs an inbound webhook, so this adapter runs a small
// HTTP server that Meta calls. Expose it with a tunnel (ngrok/cloudflared) and
// set that URL + verify token in the Meta app dashboard.

interface PendingPermission {
  kind: "permission"
  resolve: (d: "once" | "always" | "reject") => void
  timer: ReturnType<typeof setTimeout>
}
interface PendingQuestion {
  kind: "question"
  options: string[]
  resolve: (chosen: string) => void
  timer: ReturnType<typeof setTimeout>
}
type PendingReply = PendingPermission | PendingQuestion

interface WhatsAppExtra {
  phoneNumberId: string
  accessToken: string
  verifyToken: string
  port: number
}

function extractExtra(extra: Record<string, unknown>): WhatsAppExtra | null {
  const { phoneNumberId, accessToken, verifyToken, port } = extra
  if (typeof phoneNumberId !== "string" || typeof accessToken !== "string" || typeof verifyToken !== "string")
    return null
  return { phoneNumberId, accessToken, verifyToken, port: typeof port === "number" ? port : 3100 }
}

function parseCommand(text: string): { command: string; args: string } | null {
  const t = text.trimStart()
  if (!t.startsWith("/")) return null
  const sp = t.indexOf(" ")
  if (sp === -1) return { command: t.slice(1).toLowerCase(), args: "" }
  return { command: t.slice(1, sp).toLowerCase(), args: t.slice(sp + 1).trim() }
}

const WA_MAX = 4000

function makeWhatsAppAdapter(cfg: ChannelConfig, extra: WhatsAppExtra): ChannelAdapter {
  const allowed = new Set(cfg.allowedIds)
  const pendingReplies = new Map<string, PendingReply>()
  let server: http.Server | null = null

  const graph = async (body: unknown, ctx?: GatewayContext) => {
    try {
      await fetch(`https://graph.facebook.com/v21.0/${extra.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${extra.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    } catch (err: any) {
      ctx?.log("whatsapp", `graph send failed: ${err?.message ?? err}`)
    }
  }

  const sendTextTo = (to: string, text: string, ctx?: GatewayContext) =>
    graph({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }, ctx)

  function makeResponder(to: string, ctx: GatewayContext): Responder {
    const sendText = async (text: string): Promise<void> => {
      if (!text) return
      for (let i = 0; i < text.length; i += WA_MAX) await sendTextTo(to, text.slice(i, i + WA_MAX), ctx)
    }
    const typing = async (): Promise<void> => {}
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
        void graph(
          {
            messaging_product: "whatsapp",
            to,
            type: "interactive",
            interactive: {
              type: "button",
              body: { text: `🔐 Permission: ${ask.action}\n${ask.detail}`.slice(0, 1024) },
              action: {
                buttons: [
                  { type: "reply", reply: { id: "pa_once", title: "✅ Allow once" } },
                  { type: "reply", reply: { id: "pa_always", title: "♾️ Always" } },
                  { type: "reply", reply: { id: "pa_reject", title: "❌ Deny" } },
                ],
              },
            },
          },
          ctx,
        )
      })
    const askQuestion = (ask: { question: string; options: string[] }) =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          pendingReplies.delete(to)
          resolve(ask.options[0] ?? "ok")
        }, 600_000)
        pendingReplies.set(to, { kind: "question", options: ask.options, resolve, timer })
        if (ask.options.length <= 3) {
          void graph(
            {
              messaging_product: "whatsapp",
              to,
              type: "interactive",
              interactive: {
                type: "button",
                body: { text: ask.question.slice(0, 1024) },
                action: {
                  buttons: ask.options.map((o, i) => ({
                    type: "reply",
                    reply: { id: `qa_${i}`, title: o.slice(0, 20) },
                  })),
                },
              },
            },
            ctx,
          )
        } else {
          const numbered = ask.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")
          void sendTextTo(to, `❓ ${ask.question}\n${numbered}\nReply with the number.`, ctx)
        }
      })
    return { sendText, typing, startStatus, askPermission, askQuestion }
  }

  // Resolve a pending ask from either an interactive button reply id or text.
  function tryResolvePending(sender: string, buttonId: string | null, body: string): boolean {
    const pending = pendingReplies.get(sender)
    if (!pending) return false
    if (pending.kind === "permission") {
      let decision: "once" | "always" | "reject" | null = null
      if (buttonId === "pa_once") decision = "once"
      else if (buttonId === "pa_always") decision = "always"
      else if (buttonId === "pa_reject") decision = "reject"
      else {
        const w = body.trim().toLowerCase()
        if (w === "allow") decision = "once"
        else if (w === "always") decision = "always"
        else if (w === "deny") decision = "reject"
      }
      if (decision === null) return false
      clearTimeout(pending.timer)
      pendingReplies.delete(sender)
      pending.resolve(decision)
      return true
    }
    let idx = -1
    if (buttonId && buttonId.startsWith("qa_")) idx = parseInt(buttonId.slice(3), 10)
    else idx = parseInt(body.trim(), 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= pending.options.length) return false
    clearTimeout(pending.timer)
    pendingReplies.delete(sender)
    pending.resolve(pending.options[idx]!)
    return true
  }

  function handleWebhookEvent(payload: any, ctx: GatewayContext) {
    const entries: any[] = payload?.entry ?? []
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        for (const message of change?.value?.messages ?? []) {
          const sender: string = message.from
          if (!sender) continue
          const buttonId: string | null = message.interactive?.button_reply?.id ?? null
          const text: string = message.text?.body ?? message.interactive?.button_reply?.title ?? ""
          if (tryResolvePending(sender, buttonId, text)) continue
          if (!allowed.has(sender)) {
            ctx.log("whatsapp", `Ignored message from unauthorized sender: ${sender}`)
            continue
          }
          const incoming: IncomingMessage = { conversationId: sender, userId: sender, text }
          const responder = makeResponder(sender, ctx)
          void (async () => {
            try {
              const parsed = parseCommand(text)
              if (parsed) await ctx.handleCommand("whatsapp", parsed.command, parsed.args, incoming, responder)
              else await ctx.handleMessage("whatsapp", incoming, responder)
            } catch (err: any) {
              ctx.log("whatsapp", `handler error for ${sender}: ${err?.message ?? err}`)
            }
          })()
        }
      }
    }
  }

  const start = async (ctx: GatewayContext): Promise<void> => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${extra.port}`)
      if (req.method === "GET" && url.pathname === "/webhook") {
        const mode = url.searchParams.get("hub.mode")
        const token = url.searchParams.get("hub.verify_token")
        const challenge = url.searchParams.get("hub.challenge")
        if (mode === "subscribe" && token === extra.verifyToken) {
          res.writeHead(200, { "content-type": "text/plain" })
          res.end(challenge ?? "")
        } else {
          res.writeHead(403)
          res.end()
        }
        return
      }
      if (req.method === "POST" && url.pathname === "/webhook") {
        let raw = ""
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          res.writeHead(200)
          res.end()
          try {
            handleWebhookEvent(JSON.parse(raw || "{}"), ctx)
          } catch (err: any) {
            ctx.log("whatsapp", `webhook parse error: ${err?.message ?? err}`)
          }
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(extra.port, () =>
      ctx.log("whatsapp", `WhatsApp webhook listening on :${extra.port}/webhook (expose via tunnel)`),
    )
  }
  const stop = async (): Promise<void> => {
    server?.close()
    server = null
    for (const [, p] of pendingReplies) clearTimeout(p.timer)
    pendingReplies.clear()
  }

  const deliver = async (conversationId: string, text: string): Promise<void> => {
    for (let i = 0; i < text.length; i += WA_MAX) await sendTextTo(conversationId, text.slice(i, i + WA_MAX))
  }

  return { id: "whatsapp", label: "WhatsApp", start, stop, deliver }
}

/**
 * Required cfg.extra: { phoneNumberId, accessToken, verifyToken, port? (3100) }.
 * cfg.allowedIds = allowlisted sender wa_id numbers. Returns undefined if incomplete.
 * Setup: tunnel the port (e.g. `ngrok http 3100`), set the https URL + verifyToken
 * as the webhook in the Meta app, subscribe to "messages".
 */
export function createWhatsAppAdapter(cfg: ChannelConfig): ChannelAdapter | undefined {
  if (!cfg.extra) return undefined
  const extra = extractExtra(cfg.extra)
  if (!extra) return undefined
  return makeWhatsAppAdapter(cfg, extra)
}
