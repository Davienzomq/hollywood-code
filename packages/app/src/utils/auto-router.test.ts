import { test, expect, describe } from "bun:test"
import { scoreTask, castAuto, castMix, pickEffort } from "./auto-router"

// A long, detailed, high-complexity, production-quality request → scores HIGH.
const HIGH_TEXT =
  "Refactor the payment system architecture for production with security and concurrency. " +
  "We must handle race conditions, database migrations, performance and scalability across many files. ".repeat(60)

describe("scoreTask", () => {
  test("greetings / trivial → low tier", () => {
    expect(scoreTask("oi").tier).toBe("low")
    expect(scoreTask("hello").tier).toBe("low")
    expect(scoreTask("thanks!").tier).toBe("low")
    expect(scoreTask("ok").tier).toBe("low")
  })

  // A SHORT high-complexity message stays MID: complexity is capped at 0.75 and
  // a short message has low context (0.2 weight), so it lands ~0.53 (mid). To
  // reach HIGH you need complexity AND size/context (a long, detailed request).
  test("short complex request → mid; long detailed complex request → high", () => {
    expect(scoreTask("refactor the payment system architecture in production").tier).toBe("mid")
    expect(scoreTask(HIGH_TEXT).tier).toBe("high")
  })

  test("score stays within [0,1]", () => {
    for (const t of ["", "oi", "x".repeat(5000), "refactor everything in production now"]) {
      const { score } = scoreTask(t)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  test('"quick"/"just testing" pushes the score down', () => {
    const plain = scoreTask("implement a parser").score
    const rushed = scoreTask("just quickly implement a parser, throwaway").score
    expect(rushed).toBeLessThanOrEqual(plain)
  })
})

const anthropic = {
  id: "anthropic",
  models: { "claude-haiku-4-5": {}, "claude-sonnet-4-6": {}, "claude-opus-4-8": {} },
}

describe("castAuto (within the active provider)", () => {
  test("low task → cheapest tier model", () => {
    const r = castAuto("oi", { activeProviderID: "anthropic", providers: [anthropic] })
    expect(r?.providerID).toBe("anthropic")
    expect(r?.modelID).toBe("claude-haiku-4-5")
    expect(r?.tier).toBe("low")
  })

  test("high task → top available tier model (fable-5 absent → opus)", () => {
    const r = castAuto(HIGH_TEXT, {
      activeProviderID: "anthropic",
      providers: [anthropic],
    })
    expect(r?.providerID).toBe("anthropic")
    expect(r?.modelID).toBe("claude-opus-4-8")
    expect(r?.tier).toBe("high")
  })

  test("mid task → mid-tier model", () => {
    const r = castAuto("refactor the payment system architecture in production", {
      activeProviderID: "anthropic",
      providers: [anthropic],
    })
    expect(r?.modelID).toBe("claude-sonnet-4-6")
    expect(r?.tier).toBe("mid")
  })

  test("unknown provider → falls back without crashing", () => {
    const r = castAuto("oi", {
      activeProviderID: "nope",
      providers: [anthropic],
      fallback: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    })
    expect(r?.modelID).toBe("claude-haiku-4-5")
  })
})

describe("castMix (cross-provider)", () => {
  test("low task → the free/fallback double", () => {
    const r = castMix("oi", {
      providers: [anthropic],
      fallback: { providerID: "opencode", modelID: "big-pickle" },
    })
    expect(r?.modelID).toBe("big-pickle")
  })

  test("high task → best paid model across providers (anthropic preferred over opencode)", () => {
    const r = castMix(HIGH_TEXT, {
      providers: [anthropic, { id: "opencode", models: { "big-pickle": {} } }],
      fallback: { providerID: "opencode", modelID: "big-pickle" },
    })
    expect(r?.providerID).toBe("anthropic")
    expect(r?.modelID).toBe("claude-opus-4-8")
  })
})

describe("pickEffort", () => {
  test("low tier prefers low effort, high tier prefers xhigh/high", () => {
    expect(pickEffort(["low", "medium", "high"], "low")).toBe("low")
    expect(pickEffort(["low", "medium", "high", "xhigh"], "high")).toBe("xhigh")
    expect(pickEffort([], "low")).toBeUndefined()
  })
})
