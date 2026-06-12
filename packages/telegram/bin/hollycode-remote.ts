#!/usr/bin/env bun
import { runWizard } from "../src/setup"
import { loadConfig, saveConfig } from "../src/config"
import { startBridge } from "../src/index"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const SELF = fileURLToPath(import.meta.url)
const PKG_DIR = path.resolve(path.dirname(SELF), "..")
const PIDFILE = path.join(os.homedir(), ".config", "hollywood", "telegram.pid")

// Kill EVERY stray bridge instance (and their child servers). The pidfile
// only remembers the most recent one; any forgotten instance keeps polling
// Telegram and the bots kill each other with 409 conflicts.
function killStrayBridges() {
  if (process.platform === "win32") {
    const ps =
      `Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*hollycode-remote*' -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne ${process.ppid} } | ` +
      `ForEach-Object { ` +
      `Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $_.ProcessId) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
      `Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 15000 })
  } else {
    spawnSync("sh", ["-c", `pkill -f 'hollycode-remote.*--bridge' 2>/dev/null || true`], { stdio: "ignore" })
  }
  // also anything tracked in the pidfile (covers the spawned server)
  try {
    const old = JSON.parse(fs.readFileSync(PIDFILE, "utf8")) as { bot?: number; server?: number }
    for (const pid of [old.bot, old.server]) {
      if (pid && pid !== process.pid && pid !== process.ppid) {
        try {
          process.kill(pid)
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // no pidfile
  }
}

const args = process.argv.slice(2)
let cliModel: string | undefined
let cliDirectory: string | undefined
let bridgeMode = false // internal: this IS the detached background process
let foreground = false // debugging: run the bridge in this terminal

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model" && args[i + 1]) cliModel = args[++i]
  else if (args[i] === "--directory" && args[i + 1]) cliDirectory = args[++i]
  else if (args[i] === "--bridge") bridgeMode = true
  else if (args[i] === "--foreground") foreground = true
  else if (args[i] === "--stop") {
    killStrayBridges()
    console.log("⏹  Bot stopped.")
    process.exit(0)
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Hollywood Code — Remote Control (Telegram)")
    console.log("")
    console.log("Usage: hollycode-remote [options]")
    console.log("")
    console.log("Options:")
    console.log("  --model <provider/id>     Model to use (default: server default)")
    console.log("  --directory <path>        Project directory (default: current dir)")
    console.log("  --stop                    Stop the background bot")
    console.log("  --foreground              Run attached to this terminal (debugging)")
    console.log("  --help                    Show this help")
    process.exit(0)
  }
}

const cwd = cliDirectory || process.cwd()

let config = loadConfig()
if (!config) {
  console.log("")
  console.log("⚙️  First time setup — let's configure Telegram...")
  console.log("")
  config = await runWizard(cwd)
}
if (cliModel) config.model = cliModel
if (cliDirectory && config.directory !== cliDirectory) {
  config.directory = cliDirectory
  saveConfig(config) // persist like /move does — next plain run stays here
}

if (bridgeMode || foreground) {
  // The actual long-lived bridge process.
  await startBridge(config)
} else {
  // Launch the bridge DETACHED (no console): closing this window must not
  // kill the bot — same always-on behavior as OpenClaw/Hermes daemons.
  killStrayBridges()
  const logDir = path.join(
    process.env["LOCALAPPDATA"] || path.join(os.homedir(), ".local", "share"),
    "hollywood",
    "logs",
  )
  fs.mkdirSync(logDir, { recursive: true })
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
  const logFile = path.join(logDir, `bot-${ts}.log`)
  const errFile = path.join(logDir, `bot-${ts}.err`)
  const passthrough = [
    ...(cliModel ? ["--model", cliModel] : []),
    ...(cliDirectory ? ["--directory", cliDirectory] : []),
  ]

  if (process.platform === "win32") {
    // Start-Process creates a fully independent hidden process — bun's own
    // detached spawn leaves a wrapper→child chain that dies with the console.
    // Each argument gets embedded double quotes: -ArgumentList joins elements
    // with spaces WITHOUT quoting, which split paths like "Bedroom Elegance".
    const psArgs = ["run", SELF, "--bridge", ...passthrough].map((a) => `'"${a.replaceAll("'", "''")}"'`).join(",")
    const psCmd =
      `Start-Process -FilePath '${process.execPath}' -ArgumentList @(${psArgs}) ` +
      `-WindowStyle Hidden -WorkingDirectory '${PKG_DIR}' ` +
      `-RedirectStandardOutput '${logFile}' -RedirectStandardError '${errFile}'`
    spawnSync("powershell.exe", ["-NoProfile", "-Command", psCmd], { stdio: "ignore", timeout: 20000 })
  } else {
    const out = fs.openSync(logFile, "a")
    const err = fs.openSync(errFile, "a")
    const child = spawn(process.execPath, ["run", SELF, "--bridge", ...passthrough], {
      cwd: PKG_DIR,
      detached: true,
      stdio: ["ignore", out, err],
    })
    child.unref()
  }

  console.log("")
  console.log("✅  You're connected to Telegram")
  console.log("📁  Directory: " + (config.directory || cwd))
  if (config.model) console.log("🤖  Model: " + config.model)
  console.log("")
  console.log("🎬  Bot is starting in the BACKGROUND — you can close this window.")
  console.log("📄  Logs: " + logFile)
  console.log("⏹   To stop it later: hollycode-remote --stop")
  process.exit(0)
}
