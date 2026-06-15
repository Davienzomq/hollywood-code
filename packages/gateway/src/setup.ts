// Hollycode Gateway — channel setup wizard.
// Hermes-style onboarding: ask which messaging channel to connect, then run
// that channel's pairing flow. Today Telegram ships; new channels register
// here as they're added. Saves to gateway.json (separate from the legacy
// telegram.json, so building the gateway never disturbs the current bot).
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import {
  loadGatewayConfig,
  saveGatewayConfig,
  configPath,
  channel,
  importLegacyTelegram,
  type GatewayConfig,
} from "./config"
import type { ChannelConfig } from "./types"
import { installStartup, startupStatus } from "./startup"

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`
async function tg(token: string, method: string, params?: Record<string, unknown>) {
  const res = await fetch(API(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params ?? {}),
  })
  return (await res.json()) as { ok: boolean; result?: any; description?: string }
}

// Channels the wizard can set up. Each returns a ChannelConfig block.
const SETUPS: Record<string, { label: string; run: (rl: readline.Interface) => Promise<ChannelConfig> }> = {
  telegram: { label: "Telegram", run: setupTelegram },
  discord: { label: "Discord", run: setupDiscord },
  email: { label: "Email", run: setupEmail },
  slack: { label: "Slack", run: setupSlack },
  signal: { label: "Signal", run: setupSignal },
  whatsapp: { label: "WhatsApp", run: setupWhatsApp },
}

async function setupSlack(rl: readline.Interface): Promise<ChannelConfig> {
  console.log("\n  Slack: create an app (api.slack.com/apps), enable Socket Mode,")
  console.log("  add bot scopes (chat:write, app_mentions:read, im:history), install to workspace.")
  const botToken = (await rl.question("  Bot token (xoxb-): ")).trim()
  const appToken = (await rl.question("  App token (xapp-, Socket Mode): ")).trim()
  const signingSecret = (await rl.question("  Signing secret: ")).trim()
  const ids = (await rl.question("  Allowed Slack user IDs (comma-separated): ")).trim()
  const allowedIds = ids.split(",").map((s) => s.trim()).filter(Boolean)
  return { id: "slack", enabled: true, allowedIds, extra: { botToken, appToken, signingSecret } }
}

async function setupSignal(rl: readline.Interface): Promise<ChannelConfig> {
  console.log("\n  Signal: run the signal-cli-rest-api container and link/register the bot number.")
  console.log("  docker run -p 8080:8080 -e MODE=json-rpc bbernhard/signal-cli-rest-api")
  const apiUrl = (await rl.question("  API URL [http://127.0.0.1:8080]: ")).trim() || "http://127.0.0.1:8080"
  const number = (await rl.question("  Bot Signal number (+15551234567): ")).trim()
  const ids = (await rl.question("  Allowed sender numbers (comma-separated): ")).trim()
  const allowedIds = ids.split(",").map((s) => s.trim()).filter(Boolean)
  return { id: "signal", enabled: true, allowedIds, extra: { apiUrl, number } }
}

async function setupWhatsApp(rl: readline.Interface): Promise<ChannelConfig> {
  console.log("\n  WhatsApp Cloud API: from the Meta app dashboard, get the phone number ID + access token.")
  console.log("  Set the webhook to your tunnel URL (e.g. ngrok) /webhook with the verify token below.")
  const phoneNumberId = (await rl.question("  Phone number ID: ")).trim()
  const accessToken = (await rl.question("  Access token: ")).trim()
  const verifyToken = (await rl.question("  Verify token (you choose this): ")).trim()
  const portRaw = (await rl.question("  Webhook port [3100]: ")).trim()
  const ids = (await rl.question("  Allowed sender numbers / wa_id (comma-separated): ")).trim()
  const allowedIds = ids.split(",").map((s) => s.trim()).filter(Boolean)
  return {
    id: "whatsapp",
    enabled: true,
    allowedIds,
    extra: { phoneNumberId, accessToken, verifyToken, port: portRaw ? Number(portRaw) : 3100 },
  }
}

async function setupDiscord(rl: readline.Interface): Promise<ChannelConfig> {
  let token = ""
  for (;;) {
    console.log("\n  Create a bot at https://discord.com/developers → Bot → copy the token.")
    console.log("  Enable the MESSAGE CONTENT intent, and invite the bot to your server/DM.")
    token = (await rl.question("  Paste the bot token: ")).trim()
    if (!token) continue
    const me = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    if (me && (me as any).username) {
      console.log(`  ✓ Connected as ${(me as any).username}\n`)
      break
    }
    console.log("  ✗ Token didn't work. Try again.\n")
  }
  console.log("  In Discord, enable Developer Mode (Settings → Advanced), right-click your name → Copy User ID.")
  const ids = (await rl.question("  Allowed Discord user IDs (comma-separated): ")).trim()
  const allowedIds = ids.split(",").map((s) => s.trim()).filter(Boolean)
  return { id: "discord", enabled: true, token, allowedIds }
}

async function setupEmail(rl: readline.Interface): Promise<ChannelConfig> {
  console.log("\n  Email channel — the agent reads new mail and replies. Use an app password.")
  const user = (await rl.question("  Mailbox address (login / From): ")).trim()
  const pass = (await rl.question("  Password / app-password: ")).trim()
  const imapHost = (await rl.question("  IMAP host [imap.gmail.com]: ")).trim() || "imap.gmail.com"
  const smtpHost = (await rl.question("  SMTP host [smtp.gmail.com]: ")).trim() || "smtp.gmail.com"
  const senders = (await rl.question("  Allowed sender addresses (comma-separated): ")).trim()
  const allowedIds = senders.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  return {
    id: "email",
    enabled: true,
    allowedIds,
    extra: { imapHost, imapPort: 993, smtpHost, smtpPort: 587, user, pass, secure: true },
  }
}

async function setupTelegram(rl: readline.Interface): Promise<ChannelConfig> {
  let token = ""
  let username = ""
  for (;;) {
    console.log("\n  Open Telegram → @BotFather → /newbot → copy the token.")
    console.log("  (For testing the gateway alongside your current bot, use a SEPARATE test bot token.)")
    token = (await rl.question("  Paste the bot token: ")).trim()
    if (!token) continue
    const me = await tg(token, "getMe").catch(() => undefined)
    if (me?.ok && me.result?.username) {
      username = me.result.username
      console.log(`  ✓ Connected as @${username}\n`)
      break
    }
    console.log(`  ✗ Token didn't work${me?.description ? ` (${me.description})` : ""}. Try again.\n`)
  }

  console.log(`  Now send /start to @${username} from your phone. Waiting...\n`)
  let offset = 0
  const drain = await tg(token, "getUpdates", { timeout: 0 })
  if (drain.ok && drain.result?.length) offset = drain.result[drain.result.length - 1].update_id + 1

  const allowedIds: string[] = []
  for (;;) {
    const upd = await tg(token, "getUpdates", { timeout: 30, offset }).catch(() => undefined)
    if (!upd?.ok || !upd.result?.length) continue
    for (const u of upd.result) {
      offset = u.update_id + 1
      const from = u.message?.from
      if (!from) continue
      const id = String(from.id)
      const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || id
      const ans = (await rl.question(`  📱 ${name} (ID ${id}) wants to pair. Approve? [y/n] `)).trim().toLowerCase()
      if (["y", "yes", "s", "sim"].includes(ans)) {
        allowedIds.push(id)
        await tg(token, "sendMessage", { chat_id: from.id, text: "✓ Paired with Hollycode. Send me a task!" })
        console.log("  ✓ Paired!\n")
      }
    }
    if (allowedIds.length) break
  }
  return { id: "telegram", enabled: true, token, allowedIds }
}

export async function runGatewayWizard(directory: string): Promise<GatewayConfig> {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    console.log("\n🎬 Hollycode Gateway — Setup\n")
    const cfg: GatewayConfig = loadGatewayConfig() ?? { directory, channels: [] }
    if (!cfg.directory) cfg.directory = directory

    // Offer to reuse an existing Telegram pairing (the legacy bot).
    if (!channel(cfg, "telegram")) {
      const imported = importLegacyTelegram(cfg)
      if (imported) {
        const reuse = (await rl.question("Found an existing Telegram pairing. Reuse it? [y/n] ")).trim().toLowerCase()
        if (!["y", "yes", "s", "sim"].includes(reuse)) {
          cfg.channels = cfg.channels.filter((c) => c.id !== "telegram")
        } else {
          console.log("  ✓ Reusing the existing Telegram bot.\n")
        }
      }
    }

    for (;;) {
      const ids = Object.keys(SETUPS)
      console.log("Channels you can connect: " + ids.map((i) => SETUPS[i]!.label).join(", "))
      const have = cfg.channels.filter((c) => c.enabled).map((c) => c.id)
      if (have.length) console.log("Already connected: " + have.join(", "))
      const pick = (await rl.question("Add a channel? type its name (or press Enter to finish): ")).trim().toLowerCase()
      if (!pick) break
      const setup = SETUPS[pick]
      if (!setup) {
        console.log(`  Unknown channel "${pick}". Options: ${ids.join(", ")}\n`)
        continue
      }
      const block = await setup.run(rl)
      cfg.channels = cfg.channels.filter((c) => c.id !== block.id)
      cfg.channels.push(block)
      saveGatewayConfig(cfg)
      console.log(`  Saved ${setup.label} to ${configPath()}\n`)
    }

    if (cfg.model === undefined) cfg.model = "auto"

    // Optional: voice transcription (Phase B).
    if (!cfg.voice) {
      const wantVoice = (await rl.question("Enable voice transcription? [y/n] ")).trim().toLowerCase()
      if (["y", "yes", "s", "sim"].includes(wantVoice)) {
        const apiKey = (await rl.question("  Transcription API key (OpenAI/Groq): ")).trim()
        const apiUrl = (await rl.question("  API base URL [https://api.openai.com/v1]: ")).trim()
        const model = (await rl.question("  Model [whisper-1]: ")).trim()
        if (apiKey) {
          cfg.voice = {
            apiKey,
            ...(apiUrl ? { apiUrl } : {}),
            ...(model ? { model } : {}),
          }
        }
      }
    }

    // Optional: start automatically on boot/logon so the bot survives reboots.
    if (!startupStatus()) {
      const wantStartup = (await rl.question("Start automatically when this computer boots? [y/n] ")).trim().toLowerCase()
      if (["y", "yes", "s", "sim"].includes(wantStartup)) {
        installStartup(cfg.directory || directory)
      } else {
        console.log("  (You can enable it later with: hollycode-gateway --install-startup)\n")
      }
    }

    saveGatewayConfig(cfg)
    console.log(`Config saved to ${configPath()}. Next run goes straight online.\n`)
    return cfg
  } finally {
    rl.close()
  }
}
