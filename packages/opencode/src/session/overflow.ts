import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import type { MessageV2 } from "./message-v2"

const DEFAULT_THRESHOLD_PERCENT = 0.95

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  // Percentage-based trigger (default 95%, like Claude Code's auto-compact),
  // configurable via compaction.threshold_percent.
  const rawPercent = input.cfg.compaction?.threshold_percent ?? DEFAULT_THRESHOLD_PERCENT
  const percent = Math.max(0, Math.min(1, rawPercent))
  const percentBased = Math.floor(context * percent)

  // If the user explicitly sets a `reserved` token buffer, honor it as a hard
  // safety cap (fire at whichever limit is hit first). Otherwise the percentage
  // alone controls — the remaining (1 - percent) window is the implicit buffer.
  if (input.cfg.compaction?.reserved !== undefined) {
    const reserved = input.cfg.compaction.reserved
    const reserveBased = input.model.limit.input
      ? Math.max(0, input.model.limit.input - reserved)
      : Math.max(0, context - reserved)
    return Math.min(percentBased, reserveBased)
  }

  return percentBased
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
