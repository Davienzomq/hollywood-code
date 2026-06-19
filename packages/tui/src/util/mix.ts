// Mix model (cross-provider router) for the TUI — mirrors the gateway's
// castForMix (packages/gateway/src/engine.ts). The TUI normally pins the
// selected model per prompt; when mix is ON it instead scores each message and
// casts ACROSS providers: easy → free double, hard → best paid model of any
// provider. Pure module: no Solid, no IO — fed the live provider list + table.

export type Tier = "low" | "mid" | "high"

const HC_HIGH =
  /\b(architect(ure)?|design\s+(a|the|an)?\s*(system|api|schema)|refactor|migrat(e|ion)|debug|race\s*condition|deadlock|concurren|optimi[sz]e|algorithm|security|vulnerab|authenticat|performance|scal(e|ing|ability)|implement|integrat(e|ion)|build\s+(a|an|the|me)|create\s+(a|an|the|me)|rewrite|overhaul)\b/i
const HC_LOW =
  /^(hi|hey|hello|oi|ol[aá]|thanks?|thank you|valeu|obrigad[oa]|ok|sure|yes|no|nice|cool|legal|great|what( is|'s)|who( is|'s)|when|explain|summari[sz]e|translate|format|rename|list)\b/i
const HC_QUALITY = /\b(production|prod\b|critical|public\s+api|deploy|release|customer|security|payment|sensitive)\b/i
const HC_SPEED = /\b(quick(ly)?|fast|just|simple|simples|r[aá]pido|draft|rough|throwaway|prototype|test(ing)?\s+only)\b/i
const HC_FILE = /[\w./\\-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|css|html|json|yml|yaml|md|sql|sh|ps1|lua|c|cpp|h)\b/gi
const HC_CODE = /```|\n {4}\S/
const HC_STACK = /\b(at\s+\S+\s+\(|Traceback|Error:|exception|panic:)/i
const HC_MULTI = /\b(and|then|also|plus|e\s+depois|al[eé]m)\b/gi

export function scoreTask(text: string): { tier: Tier; score: number } {
  const t = text.trim()
  const len = t.length
  let complexity = 0.35
  if (HC_LOW.test(t)) complexity = 0.1
  if (HC_HIGH.test(t)) complexity = 0.75
  if (HC_CODE.test(t) || HC_STACK.test(t)) complexity = Math.max(complexity, 0.55)
  if ((t.match(HC_MULTI) ?? []).length >= 4 && len > 300) complexity = Math.min(1, complexity + 0.15)
  let context = 0.1
  if (len > 300) context = 0.3
  if (len > 1000) context = 0.6
  if (len > 4000) context = 0.9
  if ((t.match(HC_FILE) ?? []).length >= 2) context = Math.min(1, context + 0.2)
  let quality = 0.4
  if (HC_QUALITY.test(t)) quality = 0.85
  if (HC_LOW.test(t) && len < 200) quality = 0.2
  const speed = HC_SPEED.test(t) ? 0.7 : 0
  const score = Math.min(1, Math.max(0, 0.4 * complexity + 0.2 * context + 0.25 * quality - 0.15 * speed))
  const tier: Tier = score <= 0.33 ? "low" : score <= 0.66 ? "mid" : "high"
  return { tier, score }
}

const TIER_MODELS: Record<string, Record<Tier, string[]>> = {
  openai: {
    low: ["gpt-5.4-mini", "gpt-5-nano", "gpt-5-mini"],
    mid: ["gpt-5.4", "gpt-5-mini", "gpt-5"],
    high: ["gpt-5.5", "gpt-5.4-codex", "gpt-5.4", "gpt-5"],
  },
  anthropic: {
    low: ["claude-haiku-4-5", "claude-3-5-haiku"],
    mid: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"],
    high: ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-5"],
  },
  google: {
    low: ["gemini-3-flash", "gemini-2.5-flash"],
    mid: ["gemini-3-pro", "gemini-2.5-pro"],
    high: ["gemini-3-ultra", "gemini-ultra"],
  },
  opencode: {
    low: ["claude-haiku-4-5", "deepseek-v4-flash-free", "big-pickle"],
    mid: ["big-pickle", "qwen3-coder", "claude-sonnet-4-6"],
    high: ["claude-fable-5", "claude-opus-4-8", "big-pickle"],
  },
}

function pickEffort(keys: string[], tier: Tier): string | undefined {
  if (!keys.length) return undefined
  const pref =
    tier === "low" ? ["low", "minimal", "none"] : tier === "mid" ? ["medium", "low", "high"] : ["xhigh", "high", "max", "medium"]
  for (const p of pref) if (keys.includes(p)) return p
  return tier === "high" ? keys[keys.length - 1] : keys[0]
}

export interface ProviderInfo {
  id: string
  models: Record<string, { variants?: Record<string, unknown> }>
}
export type MixTable = { low?: string; mid?: string; high?: string }

function parseRef(s?: string): { providerID: string; modelID: string } | undefined {
  if (!s || !s.includes("/")) return undefined
  const i = s.indexOf("/")
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

/**
 * Cast a model + effort for the task, ACROSS providers. Returns undefined when
 * nothing resolves (caller keeps the user's selected model). `freeProviderID`
 * is the provider used for the cheap "double" (typically "opencode").
 */
export function castMix(
  text: string,
  providers: ProviderInfo[],
  table: MixTable | undefined,
  freeProviderID = "opencode",
): { providerID: string; modelID: string; variant?: string; tier: Tier } | undefined {
  const { tier } = scoreTask(text)
  const modelOf = (p: string, m: string) => providers.find((x) => x.id === p)?.models?.[m]
  const variantOf = (p: string, m: string) => pickEffort(Object.keys(modelOf(p, m)?.variants ?? {}), tier)

  // 1. explicit table entry for this tier
  const explicit = parseRef(table?.[tier])
  if (explicit && modelOf(explicit.providerID, explicit.modelID)) {
    return { ...explicit, variant: variantOf(explicit.providerID, explicit.modelID), tier }
  }
  // 2. auto-detect: low → free double; mid/high → best paid across providers
  if (tier === "low") {
    const free = providers.find((p) => p.id === freeProviderID)
    for (const c of TIER_MODELS[freeProviderID]?.low ?? []) {
      if (free?.models?.[c]) return { providerID: freeProviderID, modelID: c, variant: variantOf(freeProviderID, c), tier }
    }
    // any free-provider model
    const first = free && Object.keys(free.models)[0]
    if (first) return { providerID: freeProviderID, modelID: first, variant: variantOf(freeProviderID, first), tier }
  }
  const order = [...providers.filter((p) => p.id !== freeProviderID), ...providers.filter((p) => p.id === freeProviderID)]
  for (const p of order) {
    for (const c of TIER_MODELS[p.id]?.[tier] ?? []) {
      if (p.models?.[c]) return { providerID: p.id, modelID: c, variant: variantOf(p.id, c), tier }
    }
  }
  return undefined
}
