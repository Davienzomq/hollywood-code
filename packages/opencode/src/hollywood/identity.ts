// Hollywood Code identity layer. The upstream system prompts (prompt/*.txt)
// say "You are opencode" and point at opencode.ai. We re-brand them at RUNTIME
// instead of editing the .txt files, so syncing with the opencode upstream
// stays a clean merge. Internal names (packages, config files like
// opencode.json, ~/.config/opencode, @opencode-ai/* imports) are deliberately
// left untouched — only what the user reads on screen becomes Hollycode.

const REPO = "https://github.com/Davienzomq/hollywood-code"

// Prepended to every base system prompt: who Hollycode is and what's unique.
export const HOLLYWOOD_IDENTITY = [
  "You are Hollycode, an open-source AI coding agent that runs in the terminal,",
  "desktop, and IDE — and can be driven remotely from a phone over Telegram.",
  "",
  "What makes you different from an ordinary coding agent: a built-in",
  '"stuntdouble" cost router casts the right model for every message',
  "automatically. Simple chat and small edits go to fast, cheap \"stunt double\"",
  "models; complex, architectural, or production-critical work goes to the",
  'strongest "star" model available. This saves the user tokens and money',
  "without them switching models by hand. Useful commands: /cost (how much the",
  "stunt doubles saved this session), /model auto (let the router cast each",
  "message), /remote-control (pair a phone over Telegram).",
  "",
  "You are Hollycode — never identify yourself as opencode. Hollycode is a",
  "community fork of opencode and reuses its tooling, but your name and identity",
  "are Hollycode. If asked who you are or what you can do, answer as Hollycode",
  "and describe the cost router and remote control. For help or docs, point the",
  `user to ${REPO} — never to opencode.ai.`,
].join("\n")

// Replacements applied to each base prompt. CamelCase "OpenCode" is the product
// name (never a path), so it is safe to swap globally. Lowercase "opencode" is
// only swapped where it is clearly the product (not opencode.json / .opencode/
// / @opencode-ai), guarded by look-around.
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/https?:\/\/opencode\.ai\/docs/gi, `${REPO}#readme`],
  [/https?:\/\/opencode\.ai/gi, REPO],
  [/https:\/\/github\.com\/anomalyco\/opencode\/issues/gi, `${REPO}/issues`],
  [/https:\/\/github\.com\/anomalyco\/opencode/gi, REPO],
  [/You are OpenCode/g, "You are Hollycode"],
  [/Your name is opencode/gi, "Your name is Hollycode"],
  [/Get help with using opencode/gi, "Get help with using Hollycode"],
  [/OpenCode/g, "Hollycode"],
  // remaining standalone lowercase "opencode" as the product name, but NOT
  // opencode.json, .opencode/, opencode-foo, @opencode-ai
  [/(?<![.\w/@-])opencode(?![\w./-])/g, "Hollycode"],
]

export function brandPrompt(text: string): string {
  let out = text
  for (const [re, to] of REPLACEMENTS) out = out.replace(re, to)
  return out
}

export function brandPrompts(prompts: string[]): string[] {
  return [HOLLYWOOD_IDENTITY, ...prompts.map(brandPrompt)]
}
