import { createEngine } from "./engine"
import { createTelegramAdapter } from "./adapters/telegram"
import { createDiscordAdapter } from "./adapters/discord"
import { createEmailAdapter } from "./adapters/email"
import { createSlackAdapter } from "./adapters/slack"
import { createSignalAdapter } from "./adapters/signal"
import { createWhatsAppAdapter } from "./adapters/whatsapp"
import { activeChannels, type GatewayConfig } from "./config"
import { createScheduler } from "./scheduler"
import type { ChannelAdapter, ChannelConfig } from "./types"

// Maps a channel config block → an adapter instance. Adding a platform = one
// case here + one entry in the setup wizard; everything else flows through the
// shared engine via GatewayContext.
function buildAdapter(ch: ChannelConfig): ChannelAdapter | undefined {
  switch (ch.id) {
    case "telegram":
      return ch.token ? createTelegramAdapter({ token: ch.token }) : undefined
    case "discord":
      return ch.token ? createDiscordAdapter({ token: ch.token }) : undefined
    case "email":
      return createEmailAdapter(ch)
    case "slack":
      return createSlackAdapter(ch)
    case "signal":
      return createSignalAdapter(ch)
    case "whatsapp":
      return createWhatsAppAdapter(ch)
    default:
      return undefined
  }
}

export async function startGateway(config: GatewayConfig) {
  console.log("🎬 Hollycode Gateway starting...")
  const engine = await createEngine(config)
  console.log("Server ready. Project directory:", config.directory)

  const adapters: ChannelAdapter[] = []
  for (const ch of activeChannels(config)) {
    const adapter = buildAdapter(ch)
    if (!adapter) {
      console.warn(`No adapter available for channel "${ch.id}" — skipping.`)
      continue
    }
    try {
      await adapter.start(engine.context)
      adapters.push(adapter)
      console.log(`⚡ ${adapter.label} online (${ch.allowedIds.length} paired)`)
    } catch (err) {
      console.error(`Failed to start ${adapter.label}:`, err)
    }
  }

  if (adapters.length === 0) {
    console.warn("⚠️  No channels active. Run the wizard to add one, then restart.")
  }

  // --- Phase C: scheduler (delivers cron results to the originating channel) ---
  const byId = new Map(adapters.map((a) => [a.id, a]))
  const deliver = async (channelId: string, conversationId: string, text: string) => {
    const adapter = byId.get(channelId)
    if (adapter?.deliver) await adapter.deliver(conversationId, text)
    else engine.context.log("deliver", `channel ${channelId} can't deliver (no adapter.deliver)`)
  }
  const deliverVoice = async (channelId: string, conversationId: string, audio: Uint8Array) => {
    const adapter = byId.get(channelId)
    if (adapter?.deliverVoice) await adapter.deliverVoice(conversationId, audio)
    else engine.context.log("deliver", `channel ${channelId} can't deliver voice`)
  }
  const scheduler = createScheduler({ runPrompt: engine.runPrompt, deliver, log: engine.context.log })
  engine.setScheduler(scheduler)
  engine.setDeliver(deliver) // used by the agent send_message tool
  engine.setDeliverVoice(deliverVoice) // used by the agent say/TTS tool
  scheduler.start()

  const shutdown = () => {
    console.log("\nShutting down gateway...")
    scheduler.stop()
    for (const a of adapters) void a.stop().catch(() => {})
    engine.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  return { engine, adapters }
}
