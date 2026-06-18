import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { ChannelConfig } from "./types"

// Gateway config lives alongside the existing telegram.json but in its own
// file, so building the gateway never disturbs the current packages/telegram
// bot. Migration happens only when the user flips over.
export interface GatewayConfig {
  /** Project directory the agent works in. */
  directory: string
  /** "auto" (router casts each message) or "providerID/modelID" to pin. */
  model?: string
  /** true = approve everything; false/undefined = ask via the channel UI.
   *  Legacy: superseded by `mode` (bypass === autoAllow). Kept for migration. */
  autoAllow?: boolean
  /** Permission/agent mode: ask | auto-edit | plan | bypass | auto.
   *  - ask: confirm before edits & bash
   *  - auto-edit: edits run automatically, bash still asks
   *  - plan: read-only planning agent, no edits
   *  - bypass: approve everything
   *  - auto: pick the best mode per task (hybrid heuristic + cheap classifier) */
  mode?: "ask" | "auto-edit" | "plan" | "bypass" | "auto"
  /** Reasoning effort / model variant (provider-specific, e.g. high|max|minimal). */
  effort?: string
  /** The active provider /model auto routes WITHIN (set from the last picked
   *  model). Auto never crosses providers — it casts smaller/bigger models of
   *  this same provider by task tier. Defaults to the free provider. */
  autoProvider?: string
  /** One block per messaging channel. */
  channels: ChannelConfig[]
  /** Optional voice (Phase B): transcription (apiKey) + TTS (free local Piper or api).
   *  speakReplies = speak every reply aloud, not only when the user sent audio. */
  voice?: {
    apiKey?: string
    apiUrl?: string
    model?: string
    ttsEngine?: "piper" | "api"
    ttsModel?: string
    ttsVoice?: string
    piperBin?: string
    piperModel?: string
    speakReplies?: boolean
  }
  /** Auto-memory: agent silently curates AGENTS.md after each turn (default on). */
  autoMemory?: boolean
  /** Active personality preset name (system-prompt flavor). */
  personality?: string
  /** Skill curator: periodically archive unused auto-created skills (default on). */
  skillCurator?: boolean
  /** Archive auto-skills not touched in this many days (default 30). */
  skillMaxAgeDays?: number
  /** Native MCP tools toggled on/off by id (e.g. { browser: true }). Managed via /tools. */
  tools?: Record<string, boolean>
  /** Verbose debug logging. Toggle with /debug on|off. */
  debug?: boolean
}

const DIR = path.join(os.homedir(), ".config", "hollywood")
const FILE = path.join(DIR, "gateway.json")

export function configPath() {
  return FILE
}

export function loadGatewayConfig(): GatewayConfig | undefined {
  try {
    const raw = fs.readFileSync(FILE, "utf8").replace(/^﻿/, "")
    const cfg = JSON.parse(raw) as GatewayConfig
    if (!Array.isArray(cfg.channels)) cfg.channels = []
    return cfg
  } catch {
    return undefined
  }
}

export function saveGatewayConfig(cfg: GatewayConfig) {
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = FILE + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  fs.renameSync(tmp, FILE)
}

/** Find a channel block by id (e.g. "telegram"). */
export function channel(cfg: GatewayConfig, id: string): ChannelConfig | undefined {
  return cfg.channels.find((c) => c.id === id)
}

/** Enabled channels that have credentials. */
export function activeChannels(cfg: GatewayConfig): ChannelConfig[] {
  return cfg.channels.filter((c) => c.enabled && (c.token || c.extra))
}

/**
 * One-time migration: if the user already paired Telegram via the old
 * telegram.json, seed a telegram channel block from it so the gateway picks up
 * the existing bot without re-pairing.
 */
export function importLegacyTelegram(cfg: GatewayConfig): boolean {
  if (channel(cfg, "telegram")) return false
  try {
    const legacyPath = path.join(DIR, "telegram.json")
    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8").replace(/^﻿/, "")) as {
      token?: string
      allowedIds?: string[]
      directory?: string
      model?: string
      autoAllow?: boolean
    }
    if (!legacy.token) return false
    cfg.channels.push({
      id: "telegram",
      enabled: true,
      token: legacy.token,
      allowedIds: legacy.allowedIds ?? [],
    })
    if (!cfg.directory && legacy.directory) cfg.directory = legacy.directory
    if (cfg.model === undefined && legacy.model) cfg.model = legacy.model
    if (cfg.autoAllow === undefined && legacy.autoAllow !== undefined) cfg.autoAllow = legacy.autoAllow
    return true
  } catch {
    return false
  }
}
