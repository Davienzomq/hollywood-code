// Hollycode auto-router — the "stuntdouble" model selector, ported from the
// gateway (packages/gateway/src/engine.ts: scoreTask / TIER_MODELS / pickEffort /
// castForAuto / castForMix). Pure functions: the app scores each outgoing message
// and casts the cheapest capable model BEFORE sending, when auto/mix mode is on.
//
//   - "auto": cast WITHIN the active provider (cheap scenes -> smaller model +
//     lower reasoning effort, hard scenes -> bigger model + higher effort).
//   - "mix": cast ACROSS providers (low -> a free/cheap double, high -> the best
//     paid model of any connected provider).

export type Tier = "low" | "mid" | "high"
export type AutoMode = "off" | "auto" | "mix"

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

// Per-provider casting table: smaller -> bigger model by tier. Unavailable names
// are skipped (the cast checks each candidate against the provider's real models).
export const TIER_MODELS: Record<string, Record<Tier, string[]>> = {
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

// Pick a reasoning-effort variant matching the tier from the model's available ones.
export function pickEffort(keys: string[], tier: Tier): string | undefined {
  if (!keys.length) return undefined
  const pref =
    tier === "low"
      ? ["low", "minimal", "none"]
      : tier === "mid"
        ? ["medium", "low", "high"]
        : ["xhigh", "high", "max", "medium"]
  for (const p of pref) if (keys.includes(p)) return p
  return tier === "high" ? keys[keys.length - 1] : keys[0]
}

export type ProviderModels = { id: string; models: Record<string, { variants?: Record<string, unknown> } | undefined> }
export type ModelRef = { providerID: string; modelID: string }
export type CastResult = (ModelRef & { variant?: string; tier: Tier; score: number }) | undefined

const variantsOf = (p: ProviderModels | undefined, modelID: string) => Object.keys(p?.models?.[modelID]?.variants ?? {})

// Cast a model + effort for the task, WITHIN the active provider only.
export function castAuto(
  text: string,
  opts: { activeProviderID?: string; providers: ProviderModels[]; fallback?: ModelRef },
): CastResult {
  const { tier, score } = scoreTask(text)
  const providerID = opts.activeProviderID || opts.fallback?.providerID || "opencode"
  const p = opts.providers.find((x) => x.id === providerID)
  if (p?.models) {
    for (const c of TIER_MODELS[providerID]?.[tier] ?? []) {
      if (p.models[c]) return { providerID, modelID: c, variant: pickEffort(variantsOf(p, c), tier), tier, score }
    }
    const first = Object.keys(p.models)[0]
    if (first) return { providerID, modelID: first, variant: pickEffort(variantsOf(p, first), tier), tier, score }
  }
  if (opts.fallback)
    return { ...opts.fallback, variant: pickEffort(variantsOf(p, opts.fallback.modelID), tier), tier, score }
  return undefined
}

// Cast ACROSS providers by tier: low -> the free/fallback double, mid/high -> the
// best paid model of any connected provider (non-opencode preferred).
export function castMix(
  text: string,
  opts: { providers: ProviderModels[]; fallback?: ModelRef; mixTable?: Partial<Record<Tier, string>> },
): CastResult {
  const { tier, score } = scoreTask(text)
  const provOf = (id: string) => opts.providers.find((p) => p.id === id)
  const has = (providerID: string, modelID: string) => !!provOf(providerID)?.models?.[modelID]
  const variantFor = (providerID: string, modelID: string) => pickEffort(variantsOf(provOf(providerID), modelID), tier)

  const ref = opts.mixTable?.[tier]
  if (ref && ref.includes("/")) {
    const i = ref.indexOf("/")
    const providerID = ref.slice(0, i)
    const modelID = ref.slice(i + 1)
    if (has(providerID, modelID)) return { providerID, modelID, variant: variantFor(providerID, modelID), tier, score }
  }

  if (tier === "low" && opts.fallback) {
    return { ...opts.fallback, variant: variantFor(opts.fallback.providerID, opts.fallback.modelID), tier, score }
  }

  const order = [
    ...opts.providers.filter((p) => p.id !== "opencode"),
    ...opts.providers.filter((p) => p.id === "opencode"),
  ]
  for (const p of order) {
    for (const c of TIER_MODELS[p.id]?.[tier] ?? []) {
      if (p.models?.[c]) return { providerID: p.id, modelID: c, variant: variantFor(p.id, c), tier, score }
    }
  }
  return opts.fallback ? { ...opts.fallback, tier, score } : undefined
}

export function castModel(
  text: string,
  mode: Exclude<AutoMode, "off">,
  opts: { activeProviderID?: string; providers: ProviderModels[]; fallback?: ModelRef; mixTable?: Partial<Record<Tier, string>> },
): CastResult {
  return mode === "mix" ? castMix(text, opts) : castAuto(text, opts)
}
