import { Component, createMemo, For, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useProviders } from "@/hooks/use-providers"
import type { Message } from "@opencode-ai/sdk/v2/client"

// --- types (local, mirrors Model from SDK without importing private paths) ---

type ModelCost = {
  input: number
  output: number
  cache: {
    read: number
    write: number
  }
}

type ProviderModel = {
  name?: string
  cost?: ModelCost
}

type ProviderEntry = {
  id: string
  name?: string
  models: Record<string, ProviderModel | undefined>
}

// --- per-model aggregation ---

type ModelAgg = {
  /** display label: "providerID/modelID" or model name if available */
  label: string
  scenes: number
  tokensIn: number
  tokensOut: number
  cachRead: number
  cachWrite: number
  cost: number
  /** rate used for all-star estimate, undefined = free/unknown */
  rate: ModelCost | undefined
}

function buildInsights(
  messages: Message[],
  providers: ProviderEntry[],
): {
  byModel: ModelAgg[]
  total: number
  allStar: number
  saved: number
  pct: number
  starLabel: string
} {
  const byModel = new Map<string, ModelAgg>()

  const rateOf = (providerID: string, modelID: string): ModelCost | undefined => {
    const p = providers.find((pr) => pr.id === providerID)
    return p?.models[modelID]?.cost
  }

  const labelOf = (providerID: string, modelID: string): string => {
    const p = providers.find((pr) => pr.id === providerID)
    const modelName = p?.models[modelID]?.name
    return modelName ? `${modelName}` : `${providerID}/${modelID}`
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const key = `${msg.providerID}/${msg.modelID}`
    const t = msg.tokens
    const existing = byModel.get(key)
    const agg: ModelAgg = existing ?? {
      label: labelOf(msg.providerID, msg.modelID),
      scenes: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachRead: 0,
      cachWrite: 0,
      cost: 0,
      rate: rateOf(msg.providerID, msg.modelID),
    }

    agg.scenes++
    agg.tokensIn += t.input
    // mirror engine.ts: output + reasoning together
    agg.tokensOut += t.output + t.reasoning
    agg.cachRead += t.cache.read
    agg.cachWrite += t.cache.write
    agg.cost += msg.cost
    byModel.set(key, agg)
  }

  if (byModel.size === 0) {
    return { byModel: [], total: 0, allStar: 0, saved: 0, pct: 0, starLabel: "" }
  }

  // find the "star" — highest per-token cost model (input + output rate)
  let starKey = ""
  let starRate: ModelCost | undefined
  let starScore = -1
  for (const [key, agg] of byModel) {
    if (!agg.rate) continue
    const score = (agg.rate.input ?? 0) + (agg.rate.output ?? 0)
    if (score > starScore) {
      starScore = score
      starKey = key
      starRate = agg.rate
    }
  }

  const starAgg = byModel.get(starKey)
  const starLabel = starAgg?.label ?? starKey

  // compute totals
  let total = 0
  let allStar = 0
  for (const agg of byModel.values()) {
    total += agg.cost
    if (starRate) {
      allStar +=
        (agg.tokensIn * (starRate.input ?? 0) +
          agg.tokensOut * (starRate.output ?? 0) +
          agg.cachRead * (starRate.cache?.read ?? 0) +
          agg.cachWrite * (starRate.cache?.write ?? 0)) /
        1e6
    }
  }

  const saved = Math.max(0, allStar - total)
  const pct = allStar > 0 ? Math.round((saved / allStar) * 100) : 0

  return {
    byModel: [...byModel.values()],
    total,
    allStar,
    saved,
    pct,
    starLabel,
  }
}

// --- formatting helpers ---

function fmtUsd(n: number): string {
  return "$" + n.toFixed(4)
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

// --- component ---

export const DialogInsights: Component = () => {
  const sync = useSync()
  const language = useLanguage()
  const { params } = useSessionLayout()
  const providers = useProviders()

  const messages = createMemo(() => {
    const id = params.id
    if (!id) return [] as Message[]
    return (sync.data.message[id] ?? []) as Message[]
  })

  const insights = createMemo(() => {
    const providerList = [...providers.all().values()] as ProviderEntry[]
    return buildInsights(messages(), providerList)
  })

  const usdFmt = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
      }),
  )

  const hasData = createMemo(() => insights().byModel.length > 0)
  const allFree = createMemo(() => insights().allStar === 0)

  return (
    <Dialog
      title="🎬 Insights — stunt-double savings"
      description={
        hasData()
          ? `${messages().filter((m) => m.role === "assistant").length} assistant turns across ${insights().byModel.length} model${insights().byModel.length !== 1 ? "s" : ""}`
          : "No assistant messages in this session yet."
      }
    >
      <div class="flex flex-col gap-4 px-3 pb-4">
        {/* empty state */}
        <Show when={!hasData()}>
          <div class="text-13-regular text-text-weaker py-6 text-center">
            Start chatting to see cost breakdown.
          </div>
        </Show>

        {/* per-model table */}
        <Show when={hasData()}>
          <div class="flex flex-col gap-1">
            <div class="text-11-regular text-text-weaker uppercase tracking-wide pb-1">Per model</div>
            <div class="flex flex-col divide-y divide-border-base rounded-md border border-border-base overflow-hidden">
              {/* header row */}
              <div class="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-3 py-1.5 bg-surface-base text-11-regular text-text-weaker">
                <span>Model</span>
                <span class="text-right">Scenes</span>
                <span class="text-right">Tokens in</span>
                <span class="text-right">Tokens out</span>
                <span class="text-right">Cost</span>
              </div>

              <For each={insights().byModel}>
                {(row) => (
                  <div class="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-3 py-2 text-12-regular text-text-base bg-background-base hover:bg-surface-base transition-colors">
                    <span class="truncate font-medium text-text-strong">{row.label}</span>
                    <span class="text-right tabular-nums">{row.scenes}</span>
                    <span class="text-right tabular-nums text-text-weak">{fmtTokens(row.tokensIn + row.cachRead)}</span>
                    <span class="text-right tabular-nums text-text-weak">{fmtTokens(row.tokensOut)}</span>
                    <span class="text-right tabular-nums">{fmtUsd(row.cost)}</span>
                  </div>
                )}
              </For>
            </div>
          </div>

          {/* savings summary */}
          <div class="flex flex-col gap-2 rounded-md border border-border-base bg-surface-base px-4 py-3">
            {/* total */}
            <div class="flex items-center justify-between gap-4">
              <span class="text-12-regular text-text-weak">Total (actual)</span>
              <span class="text-12-medium text-text-strong tabular-nums">{fmtUsd(insights().total)}</span>
            </div>

            {/* all-star estimate */}
            <Show when={!allFree()}>
              <div class="flex items-center justify-between gap-4">
                <span class="text-12-regular text-text-weak">
                  All-star estimate
                  <span class="text-text-weaker ml-1">({insights().starLabel} everywhere)</span>
                </span>
                <span class="text-12-regular text-text-weak tabular-nums">{fmtUsd(insights().allStar)}</span>
              </div>
            </Show>

            {/* savings line — highlight */}
            <Show when={!allFree()}>
              <div class="mt-1 flex items-center justify-between gap-4 rounded-sm bg-background-base px-2 py-1.5">
                <span class="text-12-medium text-text-base">🤸 Saved by stunt doubles</span>
                <span class="text-12-medium tabular-nums" style={{ color: insights().saved > 0 ? "var(--syntax-success)" : "var(--text-base)" }}>
                  {fmtUsd(insights().saved)}
                  <Show when={insights().pct > 0}>
                    <span class="text-text-weaker ml-1">({insights().pct}%)</span>
                  </Show>
                </span>
              </div>
            </Show>

            {/* free model note */}
            <Show when={allFree()}>
              <div class="text-11-regular text-text-weaker mt-1">
                ℹ️ Free models only — every scene cost $0. Savings appear when paid models are used.
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

export default DialogInsights
