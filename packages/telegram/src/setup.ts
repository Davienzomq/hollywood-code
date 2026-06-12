// Hollywood Code — remote control setup wizard.
// One interactive command: paste a bot token, pair your phone, done.
// Uses Telegram's plain HTTP API (no grammy needed here), so the wizard is
// self-contained. Mirrors OpenClaw's `onboard` UX: validate → pair → save.
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { saveConfig, configPath, type RemoteConfig } from "./config"

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`

async function tg(token: string, method: string, params?: Record<string, unknown>) {
  const res = await fetch(API(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params ?? {}),
  })
  return (await res.json()) as { ok: boolean; result?: any; description?: string }
}

export async function runWizard(directory: string): Promise<RemoteConfig> {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    console.log("\n🎬 Hollywood Code — Remote Control Setup\n")
    console.log("Work on this project from your phone via Telegram.\n")

    // 1) Token — validate against getMe so a typo fails fast with a clear reason.
    let token = ""
    let username = ""
    for (;;) {
      console.log("1. Open Telegram, message @BotFather, send /newbot, and copy the token it gives you.")
      token = (await rl.question("   Paste the bot token here: ")).trim()
      if (!token) continue
      const me = await tg(token, "getMe").catch(() => undefined)
      if (me?.ok && me.result?.username) {
        username = me.result.username
        console.log(`   ✓ Connected as @${username}\n`)
        break
      }
      console.log(`   ✗ That token didn't work${me?.description ? ` (${me.description})` : ""}. Try again.\n`)
    }

    // 2) Pairing — capture whoever sends /start, so the user never hunts for
    //    their numeric ID (the part everyone finds annoying).
    console.log(`2. Now open Telegram and send /start to @${username} from your phone.`)
    console.log("   Waiting for your message...\n")
    // Drain any backlog first so an old /start can't auto-pair a stranger.
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
        const ans = (await rl.question(`   📱 ${name} (ID ${id}) wants to pair. Approve? [y/n] `)).trim().toLowerCase()
        if (ans === "y" || ans === "yes" || ans === "s" || ans === "sim") {
          allowedIds.push(id)
          await tg(token, "sendMessage", { chat_id: from.id, text: "✓ Paired with Hollywood Code. Send me a task!" })
          console.log("   ✓ Paired!\n")
        }
      }
      if (allowedIds.length) break
    }

    // 3) Persist + report.
    const cfg: RemoteConfig = { token, allowedIds, directory }
    saveConfig(cfg)
    console.log(`3. Config saved to ${configPath()}`)
    console.log("   Next time, just run the same command to go straight online.\n")
    return cfg
  } finally {
    rl.close()
  }
}
