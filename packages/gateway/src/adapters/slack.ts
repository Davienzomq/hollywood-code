import { App } from "@slack/bolt"
import type {
  ChannelAdapter,
  ChannelConfig,
  GatewayContext,
  Responder,
  StatusHandle,
  IncomingMessage,
} from "../types"

// Slack via @slack/bolt in Socket Mode — no public webhook needed. Needs a bot
// token (xoxb-), an app token (xapp-, Socket Mode), and the signing secret.

interface SlackExtra {
  botToken: string
  appToken: string
  signingSecret: string
}

function extractExtra(extra: Record<string, unknown>): SlackExtra | null {
  const { botToken, appToken, signingSecret } = extra
  if (typeof botToken !== "string" || typeof appToken !== "string" || typeof signingSecret !== "string")
    return null
  return { botToken, appToken, signingSecret }
}

function parseCommand(text: string): { command: string; args: string } | null {
  const t = text.trimStart()
  if (!t.startsWith("/")) return null
  const sp = t.indexOf(" ")
  if (sp === -1) return { command: t.slice(1).toLowerCase(), args: "" }
  return { command: t.slice(1, sp).toLowerCase(), args: t.slice(sp + 1).trim() }
}

const SLACK_MAX = 3900

function makeSlackAdapter(extra: SlackExtra): ChannelAdapter {
  const app = new App({
    token: extra.botToken,
    appToken: extra.appToken,
    signingSecret: extra.signingSecret,
    socketMode: true,
  })
  const client: any = app.client

  // Pending button resolvers keyed by an incrementing counter (stored in the
  // button value, since Slack action payloads echo the value back).
  let seq = 0
  const pendingPerms = new Map<string, (d: "once" | "always" | "reject") => void>()
  const pendingQuestions = new Map<string, { options: string[]; resolve: (s: string) => void }>()

  function makeResponder(channel: string, thread: string | undefined): Responder {
    const sendText = async (text: string): Promise<void> => {
      if (!text) return
      for (let i = 0; i < text.length; i += SLACK_MAX) {
        await client.chat
          .postMessage({ channel, thread_ts: thread, text: text.slice(i, i + SLACK_MAX) })
          .catch(() => {})
      }
    }
    const typing = async (): Promise<void> => {}
    const startStatus = async (initial: string): Promise<StatusHandle> => {
      const posted = await client.chat.postMessage({ channel, thread_ts: thread, text: initial }).catch(() => null)
      const ts = posted?.ts
      return {
        update: async (text: string) => {
          if (ts) await client.chat.update({ channel, ts, text: text.slice(0, SLACK_MAX) }).catch(() => {})
        },
        finalize: async (label: string) => {
          if (ts) await client.chat.update({ channel, ts, text: label }).catch(() => {})
        },
      }
    }
    const askPermission = (ask: { action: string; detail: string }) =>
      new Promise<"once" | "always" | "reject">((resolve) => {
        const key = String(++seq)
        pendingPerms.set(key, resolve)
        setTimeout(() => {
          if (pendingPerms.delete(key)) resolve("reject")
        }, 600_000)
        void client.chat
          .postMessage({
            channel,
            thread_ts: thread,
            text: `🔐 Permission request: ${ask.action}\n${ask.detail}`,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `🔐 *Permission request:* ${ask.action}\n${ask.detail}` } },
              {
                type: "actions",
                elements: [
                  { type: "button", action_id: "pa_o", text: { type: "plain_text", text: "✅ Allow once" }, style: "primary", value: key },
                  { type: "button", action_id: "pa_a", text: { type: "plain_text", text: "♾️ Always" }, value: key },
                  { type: "button", action_id: "pa_r", text: { type: "plain_text", text: "❌ Deny" }, style: "danger", value: key },
                ],
              },
            ],
          })
          .catch(() => {})
      })
    const askQuestion = (ask: { question: string; options: string[] }) =>
      new Promise<string>((resolve) => {
        const key = String(++seq)
        pendingQuestions.set(key, { options: ask.options, resolve })
        setTimeout(() => {
          if (pendingQuestions.delete(key)) resolve(ask.options[0] ?? "ok")
        }, 600_000)
        void client.chat
          .postMessage({
            channel,
            thread_ts: thread,
            text: ask.question,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: ask.question } },
              {
                type: "actions",
                elements: ask.options.slice(0, 5).map((o, i) => ({
                  type: "button",
                  action_id: `qa_${i}`,
                  text: { type: "plain_text", text: o.slice(0, 75) },
                  value: `${key}:${i}`,
                })),
              },
            ],
          })
          .catch(() => {})
      })
    return { sendText, typing, startStatus, askPermission, askQuestion }
  }

  const start = async (ctx: GatewayContext): Promise<void> => {
    // Permission button handlers.
    app.action(/^pa_(o|a|r)$/, async ({ ack, body, action }: any) => {
      await ack()
      const key = action.value as string
      const resolve = pendingPerms.get(key)
      if (!resolve) return
      pendingPerms.delete(key)
      const code = action.action_id.slice(3) // o|a|r
      resolve(code === "o" ? "once" : code === "a" ? "always" : "reject")
    })
    // Question button handler.
    app.action(/^qa_\d+$/, async ({ ack, action }: any) => {
      await ack()
      const [key, idxRaw] = (action.value as string).split(":")
      const pending = pendingQuestions.get(key)
      if (!pending) return
      pendingQuestions.delete(key)
      const idx = Number(idxRaw)
      pending.resolve(pending.options[idx] ?? pending.options[0] ?? "ok")
    })

    app.message(async ({ message }: any) => {
      if (message.subtype || message.bot_id || !message.text || !message.user) return
      if (!ctx.isAuthorized("slack", message.user)) return
      const thread: string | undefined = message.thread_ts || message.ts
      const conversationId = `${message.channel}:${thread}`
      const incoming: IncomingMessage = { conversationId, userId: message.user, text: message.text }
      const responder = makeResponder(message.channel, thread)
      void (async () => {
        try {
          const parsed = parseCommand(message.text)
          if (parsed) await ctx.handleCommand("slack", parsed.command, parsed.args, incoming, responder)
          else await ctx.handleMessage("slack", incoming, responder)
        } catch (err: any) {
          ctx.log("slack", `handler error: ${err?.message ?? err}`)
        }
      })()
    })

    await app.start()
    ctx.log("slack", "Slack adapter started (socket mode)")
  }
  const stop = async (): Promise<void> => {
    await app.stop().catch(() => {})
  }

  return { id: "slack", label: "Slack", start, stop }
}

/**
 * Required cfg.extra: { botToken (xoxb-), appToken (xapp-), signingSecret }.
 * cfg.allowedIds = allowlisted Slack user ids. Returns undefined if incomplete.
 */
export function createSlackAdapter(cfg: ChannelConfig): ChannelAdapter | undefined {
  if (!cfg.extra) return undefined
  const extra = extractExtra(cfg.extra)
  if (!extra) return undefined
  return makeSlackAdapter(extra)
}
