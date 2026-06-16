import { createSignal, createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import nodePath from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"
import { useToast } from "../ui/toast"
import { ACCENT_ORANGE } from "./logo"
import { useProject } from "../context/project"
import { createDialogProviderOptions } from "./dialog-provider"

// First-run onboarding — a guided, fully-orange wizard (Hermes-style):
//   welcome → tools → messaging → AI provider (+ model & auth).
// The focused row is Hollycode orange (per-option bg) and follows keyboard/mouse.
const DONE_MARKER = nodePath.join(os.homedir(), ".config", "hollywood", "onboarded")

export function onboardingDone() {
  return existsSync(DONE_MARKER)
}
function markOnboarded() {
  try {
    mkdirSync(nodePath.dirname(DONE_MARKER), { recursive: true })
    writeFileSync(DONE_MARKER, new Date().toISOString())
  } catch {}
}

const MESSAGING = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "email", label: "Email" },
  { id: "slack", label: "Slack" },
  { id: "signal", label: "Signal" },
  { id: "whatsapp", label: "WhatsApp" },
] as const

// The full tool catalog, shown like Hermes. `mcp` = real on/off (writes
// opencode.json); `on` = always-on built-in/agent tool; `off` = not available yet.
type ToolRow = { id: string; label: string; icon: string; kind: "mcp" | "on" | "off"; needsKey?: string; note?: string }
const TOOL_ROWS: ToolRow[] = [
  { id: "web", label: "Web Search & Scraping (web_search, web_extract)", icon: "🔎", kind: "on" },
  { id: "browser", label: "Browser Automation (navigate, click, type, scroll)", icon: "🌐", kind: "mcp" },
  { id: "terminal", label: "Terminal & Processes (terminal, process)", icon: "💻", kind: "on" },
  { id: "files", label: "File Operations (read, write, patch, search)", icon: "📁", kind: "on" },
  { id: "code", label: "Code Execution (execute_code)", icon: "⚡", kind: "on" },
  { id: "vision", label: "Vision / Image Analysis", icon: "👁", kind: "mcp", needsKey: "VISION_API_KEY" },
  { id: "video_analyze", label: "Video Analysis (requires video-capable model)", icon: "🎞", kind: "off" },
  { id: "image", label: "Image Generation", icon: "🎨", kind: "mcp", needsKey: "FAL_KEY" },
  { id: "video", label: "Video Generation (text-to-video)", icon: "🎬", kind: "mcp", needsKey: "FAL_KEY" },
  { id: "x_search", label: "X (Twitter) Search (requires xAI key)", icon: "𝕏", kind: "off" },
  { id: "moa", label: "Mixture of Agents", icon: "🧩", kind: "off" },
  { id: "tts", label: "Text-to-Speech (say)", icon: "🔊", kind: "on" },
  { id: "skills", label: "Skills (list, view, manage)", icon: "📚", kind: "on" },
  { id: "todo", label: "Task Planning (todo)", icon: "📋", kind: "on" },
  { id: "memory", label: "Memory (persistent across sessions)", icon: "🧠", kind: "on" },
  { id: "context_engine", label: "Context Engine", icon: "✳", kind: "off" },
  { id: "session_search", label: "Session Search (search past conversations)", icon: "🔍", kind: "on" },
  { id: "clarify", label: "Clarifying Questions (clarify)", icon: "❓", kind: "on" },
  { id: "delegate", label: "Task Delegation (delegate_task)", icon: "🤝", kind: "on" },
  { id: "cron", label: "Cron Jobs (create/list/update/remove)", icon: "⏰", kind: "on" },
  { id: "send_message", label: "Cross-Platform Messaging (send_message)", icon: "✉", kind: "on" },
  { id: "home_assistant", label: "Home Assistant (smart home control)", icon: "🏠", kind: "off" },
  { id: "spotify", label: "Spotify (playback, search, playlists)", icon: "🎵", kind: "off" },
  { id: "yuanbao", label: "Yuanbao (group info, DM)", icon: "💬", kind: "off" },
  { id: "computer_use", label: "Computer Use (desktop control)", icon: "🖥", kind: "off" },
]
const MCP_COMMAND_KEY: Record<string, string> = { browser: "browser", image: "image", video: "video", vision: "vision" }

export function DialogOnboarding() {
  const dialog = useDialog()
  const project = useProject()
  const toast = useToast()
  const providerOpts = createDialogProviderOptions()

  const [step, setStep] = createSignal(0)

  // --- tool config (writes the project opencode.json mcp block) ---
  const dir = project.instance.directory() || process.cwd()
  const cfgPath = nodePath.join(dir, "opencode.json")
  const imageMcp = fileURLToPath(new URL("../../gateway/bin/hollycode-image-mcp.ts", import.meta.url))
  const videoMcp = fileURLToPath(new URL("../../gateway/bin/hollycode-video-mcp.ts", import.meta.url))
  const visionMcp = fileURLToPath(new URL("../../gateway/bin/hollycode-vision-mcp.ts", import.meta.url))
  const command: Record<string, string[]> = {
    browser: ["npx", "-y", "@playwright/mcp@latest"],
    image: [process.execPath, "run", imageMcp],
    video: [process.execPath, "run", videoMcp],
    vision: [process.execPath, "run", visionMcp],
  }
  const readCfg = (): any => {
    try {
      if (existsSync(cfgPath)) return JSON.parse(readFileSync(cfgPath, "utf8").replace(/^﻿/, ""))
    } catch {}
    return { $schema: "https://opencode.ai/config.json" }
  }
  const init = readCfg()
  const [mcp, setMcp] = createStore<Record<string, boolean>>({
    browser: init?.mcp?.browser ? init.mcp.browser.enabled !== false : true,
    image: !!init?.mcp?.image && init.mcp.image.enabled !== false,
    video: !!init?.mcp?.video && init.mcp.video.enabled !== false,
    vision: !!init?.mcp?.vision && init.mcp.vision.enabled !== false,
  })
  const saveTools = () => {
    const raw = readCfg()
    raw.mcp = raw.mcp ?? {}
    for (const id of Object.keys(MCP_COMMAND_KEY)) raw.mcp[id] = { type: "local", command: command[id], enabled: !!mcp[id] }
    try {
      writeFileSync(cfgPath, JSON.stringify(raw, null, 2))
    } catch {}
  }

  const [messaging, setMessaging] = createStore<Record<string, boolean>>({})

  const finish = () => {
    saveTools()
    markOnboarded()
    const onMcp = TOOL_ROWS.filter((t) => t.kind === "mcp" && mcp[t.id])
    const missing = [...new Set(onMcp.filter((t) => t.needsKey && !process.env[t.needsKey!]).map((t) => t.needsKey))]
    const picked = MESSAGING.filter((m) => messaging[m.id]).map((m) => m.label)
    dialog.clear()
    DialogAlert.show(
      dialog,
      "🎬 You're all set",
      [
        "Hollycode is ready. Restart it for tool changes to take effect.",
        missing.length ? `\n⚠️ Set ${missing.join(", ")} for the tools that need a key.` : "",
        picked.length ? `\n📱 To finish pairing ${picked.join(", ")}, run /remote-control.` : "",
        "\nTips: /model change AI · /tools toggle tools · /remote-control messaging · /setup redo this.",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  const orange = <T,>(o: Omit<DialogSelectOption<T>, "bg">): DialogSelectOption<T> => ({ ...o, bg: ACCENT_ORANGE })

  // --- step 1: full tool list (Hermes-style) ---
  const toolOptions = createMemo<DialogSelectOption<string>[]>(() => {
    const opts = TOOL_ROWS.map((t) => {
      const checked = t.kind === "mcp" ? !!mcp[t.id] : t.kind === "on"
      const suffix = t.kind === "on" ? "  (always on)" : t.kind === "off" ? "  (not available yet)" : t.needsKey ? `  (needs ${t.needsKey})` : ""
      return orange<string>({
        value: t.id,
        title: `[${checked ? "✓" : " "}] ${t.icon} ${t.label}${suffix}`,
        category: "Tools — Space/Enter toggles the togglable ones",
        onSelect: () => {
          if (t.kind === "mcp") setMcp(t.id, (v) => !v)
          else if (t.kind === "on") toast.show({ message: `${t.label.split(" (")[0]} is a built-in tool — always on`, variant: "info" })
          else toast.show({ message: `Not available yet (coming later)`, variant: "info" })
        },
      })
    })
    opts.push(
      orange<string>({
        value: "__next__",
        title: "→  Save tools & continue",
        category: "Tools — Space/Enter toggles the togglable ones",
        onSelect: () => {
          saveTools()
          setStep(2)
        },
      }),
    )
    return opts
  })

  // --- step 2: messaging platforms (multi-select) ---
  const messagingOptions = createMemo<DialogSelectOption<string>[]>(() => {
    const opts = MESSAGING.map((m) =>
      orange<string>({
        value: m.id,
        title: `[${messaging[m.id] ? "✓" : " "}] ${m.label}`,
        category: "Messaging — Space/Enter to toggle (optional)",
        onSelect: () => setMessaging(m.id, (v) => !v),
      }),
    )
    opts.push(
      orange<string>({
        value: "__next__",
        title: "→  Continue to AI provider",
        category: "Messaging — Space/Enter to toggle (optional)",
        onSelect: () => setStep(3),
      }),
    )
    return opts
  })

  // --- step 3: full provider catalog + real auth (opencode), tinted orange ---
  const providerOptions = createMemo<DialogSelectOption<any>[]>(() => {
    const opts: DialogSelectOption<any>[] = providerOpts().map((o) => ({ ...o, bg: ACCENT_ORANGE }))
    opts.push(
      orange<any>({
        value: "__skip__",
        title: "Skip — I'll connect a provider later",
        onSelect: () => finish(),
      }),
    )
    return opts
  })

  const hints = [
    { title: "↑↓", label: "navigate" },
    { title: "space/enter", label: "select" },
    { title: "esc", label: "close" },
  ]

  return (
    <>
      <Show when={step() === 0}>
        <DialogSelect
          title="🎬 Welcome to Hollycode"
          renderFilter={false}
          footerHints={hints}
          options={[
            orange<string>({
              value: "start",
              title: "→  Let's set you up (tools · messaging · AI provider)",
              onSelect: () => {
                markOnboarded()
                setStep(1)
              },
            }),
            orange<string>({ value: "skip", title: "Skip setup", onSelect: () => finish() }),
          ]}
        />
      </Show>
      <Show when={step() === 1}>
        <DialogSelect title="Choose your tools" renderFilter={false} options={toolOptions()} footerHints={hints} />
      </Show>
      <Show when={step() === 2}>
        <DialogSelect title="Messaging platforms" renderFilter={false} options={messagingOptions()} footerHints={hints} />
      </Show>
      <Show when={step() === 3}>
        <DialogSelect title="Select provider" options={providerOptions()} footerHints={hints} />
      </Show>
    </>
  )
}
