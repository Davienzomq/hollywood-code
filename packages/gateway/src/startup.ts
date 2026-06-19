import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// The launcher (bin/hollycode-gateway.ts) is what runs on startup: it loads the
// saved config and brings up the multi-channel gateway, then (on Windows)
// self-detaches into a hidden background process. Keeping the boot entrypoint
// identical to a normal manual launch means /move, /model and the rest of the
// persisted config are honoured automatically after a reboot.
const SELF = fileURLToPath(import.meta.url)
const LAUNCHER = path.resolve(path.dirname(SELF), "..", "bin", "hollycode-gateway.ts")
const BUN = process.execPath
const TASK_NAME = "HollycodeRemote"

const psq = (s: string) => s.replaceAll("'", "''")

function runPwsh(script: string) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30000,
  })
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") }
}

// ---------- Windows: Task Scheduler task that fires at logon ----------
function installWindows(_directory: string) {
  // The CWD must be a directory that ALWAYS exists, NOT the project dir: the
  // project is read from the saved config at boot, and a project dir that later
  // gets deleted/renamed would make Windows refuse to start the task with
  // ERROR_DIRECTORY (0x8007010B). Home is stable.
  const workdir = os.homedir()
  // The bare launcher self-detaches into a hidden background process, so the
  // scheduled task just needs to run it once at logon and exit.
  const script = [
    "$ErrorActionPreference='Stop'",
    `$a = New-ScheduledTaskAction -Execute '${psq(BUN)}' -Argument 'run "${psq(LAUNCHER)}"' -WorkingDirectory '${psq(workdir)}'`,
    "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$t.Delay = 'PT30S'",
    `$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited`,
    "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew",
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Principal $p -Settings $s -Description 'Start Hollycode Remote (gateway) at logon.' -Force | Out-Null`,
  ].join("; ")
  const { ok, out } = runPwsh(script)
  if (!ok) {
    console.error("⚠️  Could not register the scheduled task:\n" + out.trim())
    return false
  }
  console.log(`✅  Auto-start installed — Task Scheduler task "${TASK_NAME}" runs at logon (+30s).`)
  return true
}

function removeWindows() {
  runPwsh(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`)
  console.log(`🗑  Auto-start removed (task "${TASK_NAME}").`)
  return true
}

function statusWindows() {
  return runPwsh(`if (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`).out.includes(
    "yes",
  )
}

// ---------- macOS: launchd LaunchAgent (RunAtLoad + KeepAlive) ----------
const MAC_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", "com.hollycode.remote.plist")
function installMac(_directory: string) {
  const logDir = path.join(os.homedir(), "Library", "Logs", "hollywood")
  fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })
  // launchd keeps the gateway alive, so run it in the foreground (no self-detach).
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.hollycode.remote</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN}</string>
    <string>run</string>
    <string>${LAUNCHER}</string>
    <string>--foreground</string>
  </array>
  <key>WorkingDirectory</key><string>${os.homedir()}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, "launchd.out.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "launchd.err.log")}</string>
</dict>
</plist>
`
  fs.writeFileSync(MAC_PLIST, plist)
  spawnSync("launchctl", ["unload", MAC_PLIST], { stdio: "ignore" })
  const r = spawnSync("launchctl", ["load", "-w", MAC_PLIST], { encoding: "utf8" })
  if (r.status !== 0) {
    console.error("⚠️  launchctl load failed:\n" + (r.stderr ?? "").trim())
    return false
  }
  console.log(`✅  Auto-start installed — launchd agent at ${MAC_PLIST}.`)
  return true
}
function removeMac() {
  spawnSync("launchctl", ["unload", "-w", MAC_PLIST], { stdio: "ignore" })
  try {
    fs.unlinkSync(MAC_PLIST)
  } catch {
    // not installed
  }
  console.log("🗑  Auto-start removed (launchd agent).")
  return true
}
function statusMac() {
  return fs.existsSync(MAC_PLIST)
}

// ---------- Linux: systemd user service ----------
const LINUX_UNIT = path.join(os.homedir(), ".config", "systemd", "user", "hollycode-remote.service")
function installLinux(_directory: string) {
  fs.mkdirSync(path.dirname(LINUX_UNIT), { recursive: true })
  // systemd supervises the process, so run the gateway in the foreground.
  const unit = `[Unit]
Description=Hollycode Remote (gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${os.homedir()}
ExecStart=${BUN} run ${LAUNCHER} --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
  fs.writeFileSync(LINUX_UNIT, unit)
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
  const r = spawnSync("systemctl", ["--user", "enable", "--now", "hollycode-remote.service"], { encoding: "utf8" })
  // Linger lets the service run after boot even before an interactive login.
  spawnSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "ignore" })
  if (r.status !== 0) {
    console.error("⚠️  systemctl enable failed:\n" + (r.stderr ?? "").trim())
    return false
  }
  console.log(`✅  Auto-start installed — systemd user service at ${LINUX_UNIT}.`)
  return true
}
function removeLinux() {
  spawnSync("systemctl", ["--user", "disable", "--now", "hollycode-remote.service"], { stdio: "ignore" })
  try {
    fs.unlinkSync(LINUX_UNIT)
  } catch {
    // not installed
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
  console.log("🗑  Auto-start removed (systemd user service).")
  return true
}
function statusLinux() {
  return fs.existsSync(LINUX_UNIT)
}

// ---------- public API ----------

/** Register the gateway to start automatically on boot/logon for the current OS. */
export function installStartup(directory: string) {
  switch (process.platform) {
    case "win32":
      return installWindows(directory)
    case "darwin":
      return installMac(directory)
    case "linux":
      return installLinux(directory)
    default:
      console.error(`⚠️  Auto-start is not supported on ${process.platform}.`)
      return false
  }
}

/** Remove the auto-start entry created by installStartup. */
export function removeStartup() {
  switch (process.platform) {
    case "win32":
      return removeWindows()
    case "darwin":
      return removeMac()
    case "linux":
      return removeLinux()
    default:
      console.error(`⚠️  Auto-start is not supported on ${process.platform}.`)
      return false
  }
}

/** True if auto-start is currently installed. */
export function startupStatus() {
  switch (process.platform) {
    case "win32":
      return statusWindows()
    case "darwin":
      return statusMac()
    case "linux":
      return statusLinux()
    default:
      return false
  }
}
