#!/usr/bin/env bun
import { runGatewayWizard } from "../src/setup"
import { loadGatewayConfig, saveGatewayConfig, activeChannels } from "../src/config"
import { startGateway } from "../src/gateway"
import { installStartup, removeStartup, startupStatus } from "../src/startup"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const SELF = fileURLToPath(import.meta.url)
const PKG_DIR = path.resolve(path.dirname(SELF), "..")
const PIDFILE = path.join(os.homedir(), ".config", "hollywood", "gateway.pid")

// Kill every stray gateway instance + its spawned server, so two gateways
// never poll the same bot token (Telegram 409). Mirrors hollycode-remote.
function killStray() {
  if (process.platform === "win32") {
    // Match the gateway by command line on EITHER runtime name — the installed
    // runtime is hollycode.exe (a renamed Bun), but a dev run is bun.exe. Then
    // taskkill /T tears down the whole tree (gateway -> spawned server -> its
    // child workers) so no orphans linger and two gateways never share a token.
    const ps =
      `Get-CimInstance Win32_Process -Filter "Name='hollycode.exe' OR Name='bun.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*hollycode-gateway*' -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne ${process.ppid} } | ` +
      `ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`
    spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 15000 })
  } else {
    spawnSync("sh", ["-c", `pkill -f 'hollycode-gateway.*--bridge' 2>/dev/null || true`], { stdio: "ignore" })
  }
  try {
    const old = JSON.parse(fs.readFileSync(PIDFILE, "utf8")) as { bot?: number; server?: number }
    for (const pid of [old.bot, old.server]) {
      if (pid && pid !== process.pid && pid !== process.ppid) {
        try {
          process.kill(pid)
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    /* no pidfile */
  }
}

const args = process.argv.slice(2)
let cliDirectory: string | undefined
let bridgeMode = false
let foreground = false
let forceSetup = false
let installStartupFlag = false // register OS auto-start, then exit

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--directory" && args[i + 1]) cliDirectory = args[++i]
  else if (args[i] === "--bridge") bridgeMode = true
  else if (args[i] === "--foreground") foreground = true
  else if (args[i] === "--setup") forceSetup = true
  else if (args[i] === "--install-startup") installStartupFlag = true
  else if (args[i] === "--remove-startup") {
    removeStartup()
    process.exit(0)
  } else if (args[i] === "--startup-status") {
    console.log(startupStatus() ? "✅  Auto-start is installed." : "⬜  Auto-start is not installed.")
    process.exit(0)
  } else if (args[i] === "--stop") {
    killStray()
    console.log("⏹  Gateway stopped.")
    process.exit(0)
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Hollycode Gateway — multi-channel remote control")
    console.log("")
    console.log("Usage: hollycode-gateway [options]")
    console.log("  --directory <path>   Project directory (default: current dir)")
    console.log("  --setup              Add/edit channels (Telegram, Discord, Email, Slack, Signal, WhatsApp)")
    console.log("  --stop               Stop the background gateway")
    console.log("  --install-startup    Start the gateway automatically on boot/logon")
    console.log("  --remove-startup     Remove the auto-start entry")
    console.log("  --startup-status     Show whether auto-start is enabled")
    console.log("  --foreground         Run attached to this terminal (debugging)")
    console.log("  --help               Show this help")
    process.exit(0)
  }
}

const cwd = cliDirectory || process.cwd()

let config = loadGatewayConfig()
if (forceSetup || !config || activeChannels(config).length === 0) {
  if (!forceSetup) console.log("\n⚙️  No channels configured yet — let's set one up.\n")
  config = await runGatewayWizard(cwd)
}
if (cliDirectory && config.directory !== cliDirectory) {
  config.directory = cliDirectory
  saveGatewayConfig(config)
}

if (installStartupFlag) {
  // Config is loaded, so the auto-start entry uses the saved project directory.
  const ok = installStartup(config.directory || cwd)
  process.exit(ok ? 0 : 1)
}

if (bridgeMode || foreground) {
  // --foreground used to skip killStray entirely: debugging alongside a
  // forgotten background instance meant two gateways polling the same bot
  // token (Telegram 409 wars). Foreground now clears strays too; --bridge is
  // spawned BY the launcher which already ran killStray (and killing here
  // would race our own parent).
  if (foreground && !bridgeMode) killStray()
  // Write the pidfile killStray() reads — it was dead code before (nothing
  // ever wrote it), leaving only the command-line pattern match to prevent
  // duplicate instances. Best-effort cleanup on exit.
  try {
    fs.mkdirSync(path.dirname(PIDFILE), { recursive: true })
    fs.writeFileSync(PIDFILE, JSON.stringify({ bot: process.pid }))
    process.on("exit", () => {
      try {
        const cur = JSON.parse(fs.readFileSync(PIDFILE, "utf8")) as { bot?: number }
        if (cur.bot === process.pid) fs.unlinkSync(PIDFILE)
      } catch {}
    })
  } catch {}
  await startGateway(config)
} else {
  // Launch detached + hidden so closing the window doesn't kill the gateway.
  killStray()
  const logDir = path.join(
    process.env["LOCALAPPDATA"] || path.join(os.homedir(), ".local", "share"),
    "hollywood",
    "logs",
  )
  fs.mkdirSync(logDir, { recursive: true })
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
  const logFile = path.join(logDir, `gateway-${ts}.log`)
  const errFile = path.join(logDir, `gateway-${ts}.err`)
  const passthrough = [...(cliDirectory ? ["--directory", cliDirectory] : [])]

  // The launcher used to print "✅ connected" UNCONDITIONALLY — if Start-Process
  // failed (execution policy, bad path) the user was told the gateway was live
  // when nothing was running. Check the spawn result and fail loudly.
  let launched = true
  if (process.platform === "win32") {
    const psArgs = ["run", SELF, "--bridge", ...passthrough].map((a) => `'"${a.replaceAll("'", "''")}"'`).join(",")
    const psCmd =
      `Start-Process -FilePath '${process.execPath}' -ArgumentList @(${psArgs}) ` +
      `-WindowStyle Hidden -WorkingDirectory '${PKG_DIR}' ` +
      `-RedirectStandardOutput '${logFile}' -RedirectStandardError '${errFile}'`
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", psCmd], { stdio: "pipe", timeout: 20000 })
    if (r.error || r.status !== 0) {
      launched = false
      console.error("⚠️  Could not launch the background gateway:")
      console.error("   " + (r.error?.message ?? r.stderr?.toString().trim() ?? `powershell exited ${r.status}`))
    }
  } else {
    const out = fs.openSync(logFile, "a")
    const err = fs.openSync(errFile, "a")
    const child = spawn(process.execPath, ["run", SELF, "--bridge", ...passthrough], {
      cwd: PKG_DIR,
      detached: true,
      stdio: ["ignore", out, err],
    })
    child.on("error", (e) => {
      console.error("⚠️  Could not launch the background gateway:", e.message)
    })
    child.unref()
  }
  if (!launched) {
    console.error("   Try: hollycode-gateway --foreground   (runs attached, shows the real error)")
    process.exit(1)
  }

  const channels = activeChannels(config).map((c) => c.id).join(", ") || "(none)"
  console.log("")
  console.log("✅  Hollycode Gateway connected")
  console.log("📁  Directory: " + (config.directory || cwd))
  console.log("📡  Channels: " + channels)
  console.log("")
  console.log("🎬  Running in the BACKGROUND — you can close this window.")
  console.log("📄  Logs: " + logFile)
  console.log("⏹   Stop later with: hollycode-gateway --stop")
  process.exit(0)
}
