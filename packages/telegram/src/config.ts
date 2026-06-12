// Hollywood Code — remote control config.
// Saved once by the setup wizard so the user never juggles env vars again.
// Location: ~/.config/hollywood/telegram.json (env vars still override, for CI).
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export interface RemoteConfig {
  token: string
  allowedIds: string[]
  directory: string
}

const DIR = path.join(os.homedir(), ".config", "hollywood")
const FILE = path.join(DIR, "telegram.json")

export function configPath() {
  return FILE
}

export function loadConfig(): RemoteConfig | undefined {
  // Env wins (lets power users / CI bypass the wizard entirely).
  const envToken = process.env["HOLLYWOOD_TG_TOKEN"]
  if (envToken) {
    return {
      token: envToken,
      allowedIds: (process.env["HOLLYWOOD_TG_ALLOWED_IDS"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      directory: process.env["HOLLYWOOD_TG_DIRECTORY"] || process.cwd(),
    }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(FILE, "utf8")) as RemoteConfig
    if (cfg.token) return cfg
  } catch {
    // no saved config yet
  }
  return undefined
}

export function saveConfig(cfg: RemoteConfig) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2))
}
