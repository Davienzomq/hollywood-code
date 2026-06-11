// Hollywood Code router — automatic per-message model selection.
// Scores the user message with the stuntdouble 4-dimension heuristic and
// casts the right model of the SAME provider for the tier: stunt doubles
// (low/mid) for cheap scenes, the star (high) for the hard ones. The router
// owns the whole casting table — it never asks opencode's drifting
// recent/default state who should play. Pure module: no Effect, no IO.

export type Tier = "low" | "mid" | "high"

export interface RouteResult {
  tier: Tier
  score: number
}

// Hollywood owns the full casting table. The caller validates availability
// against live provider credentials, but never asks opencode's recent/default
// model memory which model should play a tier.
const TIER_CANDIDATES: Record<string, Record<Tier, string[]>> = {
  anthropic: {
    low: ["claude-haiku-4-5", "claude-3-5-haiku"],
    mid: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"],
    // Fable 5 is the frontier tier; Opus 4.8 is the current Opus.
    high: ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-5", "claude-opus-4-1"],
  },
  openai: {
    // Codex/ChatGPT OAuth exposes the gpt-5.x line; API keys expose nano/mini.
    low: ["gpt-5.4-mini", "gpt-5-nano", "gpt-5-mini"],
    mid: ["gpt-5.4", "gpt-5-mini", "gpt-5"],
    high: ["gpt-5.5", "gpt-5.4-codex", "gpt-5.4", "gpt-5"],
  },
  google: {
    low: ["gemini-3-flash", "gemini-2.5-flash"],
    mid: ["gemini-3-pro", "gemini-2.5-pro"],
    high: ["gemini-3-ultra", "gemini-ultra"],
  },
}

export function isEnabled(): boolean {
  const v = process.env["HOLLYWOOD_ROUTER"]
  return v !== "off" && v !== "0" && v !== "false"
}

export function candidatesFor(providerID: string, tier: Tier): string[] {
  return TIER_CANDIDATES[providerID]?.[tier] ?? []
}

const CODE_FENCE = /```|\n {4}\S/
const FILE_PATH = /[\w./\\-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|css|html|json|yml|yaml|md|sql|sh|ps1|lua|c|cpp|h)\b/gi
const STACK_TRACE = /\b(at\s+\S+\s+\(|Traceback|Error:|exception|panic:)/i

const HIGH_COMPLEXITY =
  /\b(architect(ure)?|design\s+(a|the|an)?\s*(system|api|schema)|refactor|migrat(e|ion)|debug|race\s*condition|deadlock|concurren|optimi[sz]e|algorithm|security|vulnerab|authenticat|performance|scal(e|ing|ability)|implement|integrat(e|ion)|build\s+(a|an|the|me)|create\s+(a|an|the|me)|rewrite|overhaul)\b/i
const LOW_COMPLEXITY =
  /^(hi|hey|hello|oi|ol[aá]|thanks?|thank you|valeu|obrigad[oa]|ok|sure|yes|no|nice|cool|legal|great|what( is|'s)|who( is|'s)|when|explain|summari[sz]e|translate|format|rename|list)\b/i
const QUALITY_WORDS = /\b(production|prod\b|critical|public\s+api|deploy|release|customer|security|payment|sensitive)\b/i
const SPEED_WORDS = /\b(quick(ly)?|fast|just|simple|simples|r[aá]pido|draft|rough|throwaway|prototype|test(ing)?\s+only)\b/i
const MULTI_PART = /\b(and|then|also|plus|e\s+depois|al[eé]m)\b/gi

// stuntdouble scoring: complexity 40% + context 20% + quality 25% − speed 15%
export function scoreMessage(text: string): RouteResult {
  const t = text.trim()
  const len = t.length

  let complexity = 0.35
  if (LOW_COMPLEXITY.test(t)) complexity = 0.1
  if (HIGH_COMPLEXITY.test(t)) complexity = 0.75
  if (CODE_FENCE.test(t) || STACK_TRACE.test(t)) complexity = Math.max(complexity, 0.55)
  if ((t.match(MULTI_PART) ?? []).length >= 4 && len > 300) complexity = Math.min(1, complexity + 0.15)

  let context = 0.1
  if (len > 300) context = 0.3
  if (len > 1000) context = 0.6
  if (len > 4000) context = 0.9
  const files = (t.match(FILE_PATH) ?? []).length
  if (files >= 2) context = Math.min(1, context + 0.2)

  let quality = 0.4
  if (QUALITY_WORDS.test(t)) quality = 0.85
  if (LOW_COMPLEXITY.test(t) && len < 200) quality = 0.2

  const speed = SPEED_WORDS.test(t) ? 0.7 : 0

  const score = Math.min(1, Math.max(0, 0.4 * complexity + 0.2 * context + 0.25 * quality - 0.15 * speed))
  const tier: Tier = score <= 0.33 ? "low" : score <= 0.66 ? "mid" : "high"
  return { tier, score }
}
