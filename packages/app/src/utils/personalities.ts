// Hollycode personalities — a system-prompt "flavor" prepended to the SENT prompt
// (not the visible message), mirroring the gateway's PERSONALITIES map. The app
// injects personalityPrefix() as a synthetic leading text part in the request
// only, so the agent adopts the style while the user's timeline stays clean.

export type Personality = "default" | "concise" | "mentor" | "pirate" | "pair"

export const PERSONALITIES: Record<Personality, { label: string; instruction: string }> = {
  default: { label: "Default", instruction: "" },
  concise: {
    label: "Concise",
    instruction: "Be terse. Skip preamble and pleasantries. Answer directly with the fewest words that fully solve it.",
  },
  mentor: {
    label: "Mentor",
    instruction:
      "Teach as you go: briefly explain the why behind each decision and step so the user learns, without becoming verbose.",
  },
  pirate: {
    label: "Pirate",
    instruction: "Speak like a pirate (arr!), but keep every piece of technical content fully accurate and correct.",
  },
  pair: {
    label: "Pair",
    instruction:
      "Act as a hands-on pair-programmer: think aloud, propose the next concrete step, and stay collaborative and proactive.",
  },
}

export const PERSONALITY_ORDER: Personality[] = ["default", "concise", "mentor", "pirate", "pair"]

export function isPersonality(value: string): value is Personality {
  return value in PERSONALITIES
}

// The text injected ahead of the user's prompt. Empty for "default".
export function personalityPrefix(name: string | undefined): string {
  if (!name || !isPersonality(name) || name === "default") return ""
  return `[Personality: ${PERSONALITIES[name].label}] ${PERSONALITIES[name].instruction}`
}
