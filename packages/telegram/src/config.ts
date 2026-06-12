import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export interface RemoteConfig {
  token: string
  allowedIds: string[]
  directory: string
  model?: string
}

const DIR = path.join(os.homedir(), ".config", "hollywood")
const FILE = path.join(DIR, "telegram.json")

export function configPath() {
  return FILE
}

function loadDotenv(directory?: string) {
  const candidates = [
    directory && path.join(directory, ".env"),
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".hollywood.env"),
  ].filter(Boolean) as string[]

  for (const file of candidates) {
    try {
      const content = fs.readFileSync(file, "utf8")
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        const val = trimmed.slice(eq + 1).trim()
        if (!process.env[key]) process.env[key] = val
      }
    } catch {
      // file doesn't exist or can't be read — skip
    }
  }
}

export function loadConfig(): RemoteConfig | undefined {
  loadDotenv()

  const envToken = process.env["HOLLYWOOD_TG_TOKEN"]
  if (envToken) {
    return {
      token: envToken,
      allowedIds: (process.env["HOLLYWOOD_TG_ALLOWED_IDS"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      directory: process.env["HOLLYWOOD_TG_DIRECTORY"] || process.cwd(),
      model: process.env["HOLLYWOOD_TG_MODEL"] || undefined,
    }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(FILE, "utf8")) as RemoteConfig
    if (cfg.token) {
      if (!cfg.model && process.env["HOLLYWOOD_TG_MODEL"]) cfg.model = process.env["HOLLYWOOD_TG_MODEL"]
      return cfg
    }
  } catch {
    // no saved config yet
  }
  return undefined
}

export function saveConfig(cfg: RemoteConfig) {
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = FILE + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  fs.renameSync(tmp, FILE)
}
