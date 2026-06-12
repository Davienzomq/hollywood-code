#!/usr/bin/env bun
import { runWizard } from "../src/setup"
import { loadConfig } from "../src/config"
import { startBridge } from "../src/index"

const args = process.argv.slice(2)
let cliModel: string | undefined
let cliDirectory: string | undefined

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model" && args[i + 1]) cliModel = args[++i]
  else if (args[i] === "--directory" && args[i + 1]) cliDirectory = args[++i]
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Hollywood Code — Remote Control (Telegram)")
    console.log("")
    console.log("Usage: hollycode-remote [options]")
    console.log("")
    console.log("Options:")
    console.log("  --model <provider/id>     Model to use (default: server default)")
    console.log("  --directory <path>        Project directory (default: current dir)")
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
if (cliDirectory) config.directory = cliDirectory

console.log("")
console.log("✅  You're connected to Telegram")
console.log("📁  Directory: " + (config.directory || cwd))
if (config.model) console.log("🤖  Model: " + config.model)
console.log("")

await startBridge(config)
