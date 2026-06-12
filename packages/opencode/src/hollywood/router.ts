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
  // opencode zen gateway: free tier ships flash/mini doubles and Big Pickle
  // as the star; paid accounts may expose frontier models (validated live by
  // the caller, unavailable names are skipped in order).
  opencode: {
    low: ["claude-haiku-4-5", "deepseek-v4-flash-free", "north-mini-code-free", "mimo-v2.5-free"],
    mid: ["claude-sonnet-4-6", "big-pickle", "qwen3-coder", "deepseek-v4-flash-free"],
    high: ["claude-fable-5", "gpt-5.5", "claude-opus-4-8", "big-pickle", "nemotron-3-ultra-free"],
  },
}

export function isEnabled(): boolean {
  const v = process.env["HOLLYWOOD_ROUTER"]
  return v !== "off" && v !== "0" && v !== "false"
}

// Appended to the system prompt of primary agents when the router is on.
// The router casts every prompt (including subagent prompts), so the
// orchestration layer is pure instruction: decompose, parallelize, verify.
export const ORCHESTRATION_PROMPT = `# Hollywood orchestration (stuntdouble)
This harness auto-casts the model for every prompt — including every subagent
prompt: cheap scenes go to stunt doubles (smaller models of the same
provider), hard scenes get the star automatically. Use this to your advantage:
- For large tasks with 2+ independent parts (features, multi-file builds,
  research + implementation), decompose and dispatch subtasks with the task
  tool ("general" for work, "explore" for read-only research). Run independent
  subtasks in parallel. Workers start cold: each subtask prompt must carry
  full context (paths, conventions, exact deliverables).
- Phrase mechanical subtasks plainly (boilerplate, formatting, simple content)
  so they are cast to cheap doubles; phrase analysis/architecture subtasks
  explicitly so they get stronger models.
- After all subtasks complete, dispatch ONE final verification subtask:
  "Review the integrated result against the original request for production —
  fix inconsistencies directly and report what you changed." (Critical
  phrasing casts the star.)
- Small or atomic tasks: do them directly — subagent overhead costs more than
  it saves. When in doubt, prefer direct.`

// User-defined casting tables: HOLLYWOOD_TIERS env var holding JSON, e.g.
// {"mistral":{"low":["mistral-small"],"high":["mistral-large"]},
//  "ollama":{"low":["llama3.2:3b"],"high":["llama3.3:70b"]}}
// Per-tier user entries override the built-ins, so ANY provider — including
// local ones — can have doubles and a star. (opencode.json schema support is
// planned; the env var works everywhere today.) Parsed lazily and re-read
// when the raw value changes; invalid JSON is ignored safely.
let envTiers: Record<string, Partial<Record<Tier, string[]>>> | undefined
let envTiersRaw: string | undefined
function userTiers() {
  const raw = process.env["HOLLYWOOD_TIERS"]
  if (raw !== envTiersRaw) {
    envTiersRaw = raw
    envTiers = undefined
    if (raw) {
      try {
        envTiers = JSON.parse(raw)
      } catch {
        envTiers = undefined
      }
    }
  }
  return envTiers
}

export function candidatesFor(providerID: string, tier: Tier): string[] {
  const user = userTiers()?.[providerID]?.[tier]
  if (Array.isArray(user) && user.length) return user
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
