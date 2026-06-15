import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
} from "discord.js"
import type { ChannelAdapter, GatewayContext, Responder, StatusHandle, IncomingMessage } from "../types"

const DISCORD_MAX = 2000

function makeDiscordAdapter(token: string): ChannelAdapter {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  })

  // ── Responder factory ─────────────────────────────────────────────────────

  function makeResponder(message: Message): Responder {
    const channel = message.channel

    // sendText: chunk at 2000 chars
    const sendText = async (text: string): Promise<void> => {
      if (!text) return
      for (let i = 0; i < text.length; i += DISCORD_MAX) {
        const chunk = text.slice(i, i + DISCORD_MAX)
        await (channel as any).send(chunk)
      }
    }

    // typing indicator
    const typing = async (): Promise<void> => {
      await (channel as any).sendTyping().catch(() => {})
    }

    // live status message
    const startStatus = async (initial: string): Promise<StatusHandle> => {
      const sent: Message = await (channel as any).send(initial.slice(0, DISCORD_MAX))

      const update = async (text: string): Promise<void> => {
        await sent.edit(text.slice(0, DISCORD_MAX)).catch(() => {})
      }

      const finalize = async (label: string): Promise<void> => {
        await sent.edit(label.slice(0, DISCORD_MAX)).catch(() => {})
      }

      return { update, finalize }
    }

    // permission request with buttons
    const askPermission = (ask: { action: string; detail: string }): Promise<"once" | "always" | "reject"> => {
      return new Promise(async (resolve) => {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("pa:o")
            .setLabel("✅ Allow once")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("pa:a")
            .setLabel("♾️ Always")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("pa:r")
            .setLabel("❌ Deny")
            .setStyle(ButtonStyle.Danger),
        )

        const text = `🔐 Permission request:\n${ask.action}\n${ask.detail}`.slice(0, DISCORD_MAX)
        let sent: Message
        try {
          sent = await (channel as any).send({ content: text, components: [row] })
        } catch {
          resolve("reject")
          return
        }

        const collector = (sent as any).createMessageComponentCollector({
          filter: (interaction: any) => interaction.user.id === message.author.id,
          time: 600_000,
        })

        collector.on("collect", async (interaction: any) => {
          collector.stop()
          const id: string = interaction.customId
          const decision: "once" | "always" | "reject" =
            id === "pa:o" ? "once" : id === "pa:a" ? "always" : "reject"
          const label =
            decision === "once" ? "✅ Allowed once" : decision === "always" ? "♾️ Always allowed" : "❌ Denied"
          await interaction.update({ content: `${text}\n\n${label}`.slice(0, DISCORD_MAX), components: [] }).catch(() => {})
          resolve(decision)
        })

        collector.on("end", (_collected: any, reason: string) => {
          if (reason === "time") {
            sent.edit({ content: `${text}\n\n⏰ Timed out — denied`, components: [] }).catch(() => {})
            resolve("reject")
          }
        })
      })
    }

    // multiple-choice question with buttons
    const askQuestion = (ask: { question: string; options: string[] }): Promise<string> => {
      return new Promise(async (resolve) => {
        const opts = ask.options.slice(0, 5)
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...opts.map((label: string, i: number) =>
            new ButtonBuilder()
              .setCustomId(`qa:${i}`)
              .setLabel(label.slice(0, 80))
              .setStyle(ButtonStyle.Primary),
          ),
        )

        const text = `❓ ${ask.question}`.slice(0, DISCORD_MAX)
        let sent: Message
        try {
          sent = await (channel as any).send({ content: text, components: [row] })
        } catch {
          resolve(ask.options[0] ?? "ok")
          return
        }

        const collector = (sent as any).createMessageComponentCollector({
          filter: (interaction: any) => interaction.user.id === message.author.id,
          time: 600_000,
        })

        collector.on("collect", async (interaction: any) => {
          collector.stop()
          const idx = Number((interaction.customId as string).replace("qa:", ""))
          const chosen = opts[idx] ?? opts[0] ?? "ok"
          await interaction.update({ content: `${text}\n\n👉 ${chosen}`.slice(0, DISCORD_MAX), components: [] }).catch(() => {})
          resolve(chosen)
        })

        collector.on("end", (_collected: any, reason: string) => {
          if (reason === "time") {
            sent.edit({ content: `${text}\n\n⏰ Timed out`, components: [] }).catch(() => {})
            resolve(opts[0] ?? "ok")
          }
        })
      })
    }

    return { sendText, typing, startStatus, askPermission, askQuestion }
  }

  // ── ChannelAdapter implementation ─────────────────────────────────────────

  const start = async (ctx: GatewayContext): Promise<void> => {
    client.on("messageCreate", (message: Message) => {
      // Ignore bots (including self)
      if (message.author.bot) return

      // Auth check — drop unauthorized users
      if (!ctx.isAuthorized("discord", message.author.id)) {
        ctx.log("discord", `Ignored message from unauthorized id: ${message.author.id}`)
        return
      }

      const text = message.content
      const incomingMsg: IncomingMessage = {
        conversationId: message.channelId,
        userId: message.author.id,
        text,
      }
      const responder = makeResponder(message)

      if (text.startsWith("/")) {
        // "/command rest of args" → split into command + args
        const withoutSlash = text.slice(1)
        const firstSpace = withoutSlash.indexOf(" ")
        const command = firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace)
        const args = firstSpace === -1 ? "" : withoutSlash.slice(firstSpace + 1).trim()

        // DETACHED: awaiting the prompt here would block button-interaction
        // handlers from being processed, causing a deadlock when the prompt
        // waits for a permission reply that is itself waiting on this handler.
        void (async () => {
          await ctx.handleCommand("discord", command, args, incomingMsg, responder)
        })()
      } else {
        // DETACHED: same reason as above — button interactions must be free to
        // resolve while the prompt is running.
        void (async () => {
          await ctx.handleMessage("discord", incomingMsg, responder)
        })()
      }
    })

    client.on("error", (err: Error) => {
      console.error("DiscordAdapter client error:", err.message)
    })

    await client.login(token)
    ctx.log("discord", `Bot online as ${client.user?.tag ?? "(unknown)"}`)
  }

  const stop = async (): Promise<void> => {
    client.destroy()
  }

  return {
    id: "discord",
    label: "Discord",
    start,
    stop,
  }
}

/**
 * Create a DiscordAdapter from a token.
 *
 * Usage in the gateway:
 *   const adapter = createDiscordAdapter({ token: channelConfig.token! })
 *   await adapter.start(gatewayCtx)
 */
export function createDiscordAdapter(opts: { token: string }): ChannelAdapter {
  return makeDiscordAdapter(opts.token)
}

/**
 * AdapterFactory integration — lets the gateway instantiate from a ChannelConfig
 * block without knowing the adapter's constructor signature.
 *
 * Usage:
 *   import { discordAdapterFactory } from "./adapters/discord"
 *   const adapter = discordAdapterFactory.create(channelConfig)
 */
export const discordAdapterFactory = {
  id: "discord" as const,
  label: "Discord" as const,
  create(config: import("../types").ChannelConfig): ChannelAdapter | undefined {
    if (!config.token) return undefined
    return makeDiscordAdapter(config.token)
  },
}
