import { describe, expect, test } from "bun:test"
import { scoreMessage, candidatesFor, isEnabled } from "../../src/hollywood/router"

describe("hollywood router scoring", () => {
  test("casual greeting routes low", () => {
    expect(scoreMessage("oi, tudo bem?").tier).toBe("low")
    expect(scoreMessage("thanks, that worked!").tier).toBe("low")
  })

  test("simple knowledge question routes low", () => {
    expect(scoreMessage("what is a closure in javascript?").tier).toBe("low")
    expect(scoreMessage("explain the difference between let and var").tier).toBe("low")
  })

  test("everyday coding with a snippet routes mid", () => {
    const msg = "Fix this bug in my parser:\n```js\nfunction parse(x) { return x.split(',') }\n```\nIt throws on empty input"
    expect(scoreMessage(msg).tier).toBe("mid")
  })

  test("long multi-requirement production architecture routes high", () => {
    const msg = (
      "Design the architecture for a payment processing system and then implement the API schema, " +
      "also plan the database migrations and integrate the authentication layer for production security. "
    ).repeat(6)
    expect(scoreMessage(msg).tier).toBe("high")
  })

  test("speed pressure pushes the score down", () => {
    const msg = "quick draft, just a simple prototype script to test an idea"
    expect(scoreMessage(msg).tier).toBe("low")
  })

  test("mechanical rename routes low", () => {
    expect(scoreMessage("rename variable x to y in utils.ts").tier).toBe("low")
  })
})

describe("hollywood router candidates", () => {
  test("high tier names the star explicitly (router owns all tiers)", () => {
    expect(candidatesFor("openai", "high")[0]).toBe("gpt-5.5")
    expect(candidatesFor("anthropic", "high")).toContain("claude-opus-4-8")
    expect(candidatesFor("google", "high").length).toBeGreaterThan(0)
  })

  test("known providers have low-tier doubles", () => {
    expect(candidatesFor("anthropic", "low")).toContain("claude-haiku-4-5")
    expect(candidatesFor("openai", "low")).toContain("gpt-5-nano")
    expect(candidatesFor("openai", "low")).toContain("gpt-5.4-mini")
    expect(candidatesFor("google", "low")).toContain("gemini-3-flash")
  })

  test("unknown provider yields no candidates (falls back to default)", () => {
    expect(candidatesFor("mystery-ai", "low")).toEqual([])
  })

  test("HOLLYWOOD_TIERS env extends the casting table to any provider", () => {
    const prev = process.env["HOLLYWOOD_TIERS"]
    process.env["HOLLYWOOD_TIERS"] = JSON.stringify({
      mistral: { low: ["mistral-small"], high: ["mistral-large"] },
    })
    expect(candidatesFor("mistral", "low")).toEqual(["mistral-small"])
    expect(candidatesFor("mistral", "high")).toEqual(["mistral-large"])
    expect(candidatesFor("mistral", "mid")).toEqual([])

    // per-tier user override beats the built-in, other tiers keep built-ins
    process.env["HOLLYWOOD_TIERS"] = JSON.stringify({ openai: { low: ["my-tiny"] } })
    expect(candidatesFor("openai", "low")).toEqual(["my-tiny"])
    expect(candidatesFor("openai", "high")[0]).toBe("gpt-5.5")

    // invalid JSON is ignored safely
    process.env["HOLLYWOOD_TIERS"] = "{not json"
    expect(candidatesFor("openai", "low")).toContain("gpt-5.4-mini")

    if (prev === undefined) delete process.env["HOLLYWOOD_TIERS"]
    else process.env["HOLLYWOOD_TIERS"] = prev
  })
})

describe("hollywood router toggle", () => {
  test("HOLLYWOOD_ROUTER=off disables", () => {
    const prev = process.env["HOLLYWOOD_ROUTER"]
    process.env["HOLLYWOOD_ROUTER"] = "off"
    expect(isEnabled()).toBe(false)
    process.env["HOLLYWOOD_ROUTER"] = "1"
    expect(isEnabled()).toBe(true)
    if (prev === undefined) delete process.env["HOLLYWOOD_ROUTER"]
    else process.env["HOLLYWOOD_ROUTER"] = prev
  })
})
