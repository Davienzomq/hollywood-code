import { createSignal, createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
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
  { id: "videoanalyze", label: "Video Analysis (frames + vision)", icon: "🎞", kind: "mcp", needsKey: "VISION_API_KEY" },
  { id: "image", label: "Image Generation", icon: "🎨", kind: "mcp", needsKey: "FAL_KEY" },
  { id: "video", label: "Video Generation (text-to-video)", icon: "🎬", kind: "mcp", needsKey: "FAL_KEY" },
  { id: "x_search", label: "X (Twitter) Search (requires xAI key)", icon: "𝕏", kind: "off" },
  { id: "moa", label: "Mixture of Agents", icon: "🧩", kind: "off" },
  { id: "tts", label: "Text-to-Speech (say)", icon: "🔊", kind: "on" },
  { id: "skills", label: "Skills (list, view, manage)", icon: "📚", kind: "on" },
  { id: "todo", label: "Task Planning (todo)", icon: "📋", kind: "on" },
  { id: "memory", label: "Memory (persistent across sessions)", icon: "🧠", kind: "on" },
  { id: "context_engine", label: "Context Engine (runtime tools — provided by our MCP + skills system)", icon: "✳", kind: "on" },
  { id: "session_search", label: "Session Search (search past conversations)", icon: "🔍", kind: "on" },
  { id: "clarify", label: "Clarifying Questions (clarify)", icon: "❓", kind: "on" },
  { id: "delegate", label: "Task Delegation (delegate_task)", icon: "🤝", kind: "on" },
  { id: "cron", label: "Cron Jobs (create/list/update/remove)", icon: "⏰", kind: "on" },
  { id: "send_message", label: "Cross-Platform Messaging (send_message)", icon: "✉", kind: "on" },
  { id: "homeassistant", label: "Home Assistant (smart home control)", icon: "🏠", kind: "mcp", needsKey: "HA_TOKEN" },
  { id: "spotify", label: "Spotify (playback, search, playlists)", icon: "🎵", kind: "mcp", needsKey: "SPOTIFY_TOKEN" },
  { id: "yuanbao", label: "Yuanbao (group info, DM)", icon: "💬", kind: "off" },
  { id: "computeruse", label: "Computer Use (desktop control)", icon: "🖥", kind: "mcp" },
]
const MCP_COMMAND_KEY: Record<string, string> = {
  browser: "browser",
  image: "image",
  video: "video",
  vision: "vision",
  videoanalyze: "videoanalyze",
  computeruse: "computeruse",
  homeassistant: "homeassistant",
  spotify: "spotify",
}

export function DialogOnboarding() {
  const dialog = useDialog()
  const project = useProject()
  const toast = useToast()
  const providerOpts = createDialogProviderOptions()

  const [step, setStep] = createSignal(0)

  // --- tool config (writes the project opencode.json mcp block) ---
  const dir = project.instance.directory() || process.cwd()
  const cfgPath = nodePath.join(dir, "opencode.json")
  const mcpBin = (name: string) => fileURLToPath(new URL(`../../gateway/bin/hollycode-${name}-mcp.ts`, import.meta.url))
  const command: Record<string, string[]> = {
    browser: ["npx", "-y", "@playwright/mcp@latest"],
    image: [process.execPath, "run", mcpBin("image")],
    video: [process.execPath, "run", mcpBin("video")],
    vision: [process.execPath, "run", mcpBin("vision")],
    videoanalyze: [process.execPath, "run", mcpBin("videoanalyze")],
    computeruse: [process.execPath, "run", mcpBin("computeruse")],
    homeassistant: [process.execPath, "run", mcpBin("homeassistant")],
    spotify: [process.execPath, "run", mcpBin("spotify")],
  }
  const readCfg = (): any => {
    try {
      if (existsSync(cfgPath)) return JSON.parse(readFileSync(cfgPath, "utf8").replace(/^﻿/, ""))
    } catch {}
    return { $schema: "https://opencode.ai/config.json" }
  }
  const init = readCfg()
  const isOn = (id: string) => !!init?.mcp?.[id] && init.mcp[id].enabled !== false
  const [mcp, setMcp] = createStore<Record<string, boolean>>({
    browser: init?.mcp?.browser ? init.mcp.browser.enabled !== false : true,
    image: isOn("image"),
    video: isOn("video"),
    vision: isOn("vision"),
    videoanalyze: isOn("videoanalyze"),
    computeruse: isOn("computeruse"),
    homeassistant: isOn("homeassistant"),
    spotify: isOn("spotify"),
  })
  const saveTools = () => {
    const raw = readCfg()
    raw.mcp = raw.mcp ?? {}
    for (const id of Object.keys(MCP_COMMAND_KEY)) raw.mcp[id] = { type: "local", command: command[id], enabled: !!mcp[id] }
    try {
      writeFileSync(cfgPath, JSON.stringify(raw, null, 2))
    } catch {}
  }

  const [setupOpened, setSetupOpened] = createSignal(false)

  // Launch the gateway pairing wizard (token entry / pairing) in its own window —
  // it's a separate long-lived process, like the /remote-control command.
  const launchGatewaySetup = () => {
    const d = project.instance.directory() || process.cwd()
    const binTs = fileURLToPath(new URL("../../gateway/bin/hollycode-gateway.ts", import.meta.url))
    const launcher =
      (existsSync(binTs) ? `"${process.execPath}" run "${binTs}"` : "hollycode-gateway") + ` --setup --directory "${d}"`
    try {
      if (process.platform === "win32") {
        const child = spawn("cmd.exe", ["/c", `start "Hollycode Messaging Setup" /D "${d}" cmd /k "${launcher}"`], {
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        })
        child.unref()
      } else if (process.platform === "darwin") {
        const script = `tell application "Terminal"\nactivate\ndo script "cd ${JSON.stringify(d)} && ${launcher.replaceAll('"', '\\"')}"\nend tell`
        const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" })
        child.unref()
      } else {
        const sh = `cd ${JSON.stringify(d)} && ${launcher}`
        const child = spawn(
          "sh",
          ["-c", `(x-terminal-emulator -e sh -c '${sh}' || gnome-terminal -- sh -c '${sh}' || konsole -e sh -c '${sh}' || xterm -e sh -c '${sh}') >/dev/null 2>&1 &`],
          { detached: true, stdio: "ignore" },
        )
        child.unref()
      }
      setSetupOpened(true)
      toast.show({ message: "Opening messaging setup in a new window — enter your bot token / pair there", variant: "success" })
    } catch {
      toast.show({ message: "Could not open setup — run /remote-control manually", variant: "error" })
    }
  }

  const finish = () => {
    saveTools()
    markOnboarded()
    const onMcp = TOOL_ROWS.filter((t) => t.kind === "mcp" && mcp[t.id])
    const missing = [...new Set(onMcp.filter((t) => t.needsKey && !process.env[t.needsKey!]).map((t) => t.needsKey))]
    dialog.clear()
    DialogAlert.show(
      dialog,
      "🎬 You're all set",
      [
        "Hollycode is ready. Restart it for tool changes to take effect.",
        missing.length ? `\n⚠️ Set ${missing.join(", ")} for the tools that need a key.` : "",
        setupOpened() ? "\n📱 Finish pairing in the messaging-setup window that opened." : "",
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

  // --- step 2: messaging — pick a channel to set up (opens the pairing wizard) ---
  const messagingOptions = createMemo<DialogSelectOption<string>[]>(() => {
    const cat = "Messaging — pick one to set up (opens a window), or skip"
    const opts = MESSAGING.map((m) =>
      orange<string>({
        value: m.id,
        title: m.label,
        description: "opens token/pairing setup in a new window",
        category: cat,
        onSelect: () => {
          launchGatewaySetup()
          setStep(3)
        },
      }),
    )
    opts.push(
      orange<string>({
        value: "__skip__",
        title: "→  Skip — set up messaging later (/remote-control)",
        category: cat,
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
