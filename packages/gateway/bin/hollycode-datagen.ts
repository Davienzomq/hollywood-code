#!/usr/bin/env bun
/**
 * Hollycode datagen — batch trajectory generator (Hermes-style batch_runner).
 *
 * Runs a dataset of prompts through the agent in parallel and records each full
 * tool-calling trajectory (system → human → gpt+tool_calls → tool → …) as a
 * ShareGPT-format JSONL line. The output is a training/fine-tuning dataset — the
 * same idea as Hermes' `python batch_runner.py`, here driven by the embedded
 * opencode server so trajectories use Hollycode's real tools and router.
 *
 * Usage:
 *   hollycode-datagen --dataset tasks.jsonl --run-name my_run [options]
 *
 * Dataset: one JSON object per line, each with a "prompt" field:
 *   {"prompt": "Go to example.com and summarize the homepage."}
 *
 * Options:
 *   --dataset <file>      JSONL file of {"prompt": "..."} (required)
 *   --run-name <name>     Output goes to data/<name>/trajectories.jsonl
 *   --output <file>       Explicit output path (overrides --run-name)
 *   --directory <dir>     Project directory the agent works in (default: cwd)
 *   --workers <n>         Parallel workers (default: 3)
 *   --model <p/m>         Pin a model "providerID/modelID" (default: router/auto)
 *   --system <text>       Ephemeral system prompt prepended to every task
 *   --max-items <n>       Only run the first N prompts
 *   --max-turns <n>       Hint passed to the agent (default: 30)
 *   --resume              Skip prompts already present in the output file
 *   --keep-sessions       Don't delete sessions after capture (for debugging)
 */

import { createOpencodeClient } from "@opencode-ai/sdk"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"

const HERE = path.dirname(fileURLToPath(import.meta.url))

// --- args -------------------------------------------------------------------
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const datasetFile = args["dataset"] as string
const runName = (args["run-name"] as string) || "run"
const directory = (args["directory"] as string) || process.cwd()
const workers = Math.max(1, parseInt((args["workers"] as string) || "3", 10))
const model = args["model"] as string | undefined
const system = args["system"] as string | undefined
const maxItems = args["max-items"] ? parseInt(args["max-items"] as string, 10) : Infinity
const maxTurns = args["max-turns"] ? parseInt(args["max-turns"] as string, 10) : 30
const resume = !!args["resume"]
const keepSessions = !!args["keep-sessions"]
const outputFile =
  (args["output"] as string) || path.join(directory, "data", runName, "trajectories.jsonl")

if (!datasetFile || args["help"]) {
  console.log("Usage: hollycode-datagen --dataset tasks.jsonl --run-name my_run [--workers 3] [--model p/m] [--system ...] [--resume]")
  process.exit(args["help"] ? 0 : 1)
}

// --- server boot (same pattern as the gateway engine) -----------------------
function bootServer(dir: string): Promise<{ url: string; proc: ChildProcess }> {
  const serverIndex = path.resolve(HERE, "../../opencode/src/index.ts")
  const proc = spawn(
    process.execPath,
    ["run", serverIndex, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    { cwd: dir, env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] },
  )
  return new Promise((resolve, reject) => {
    let buf = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(new Error("server did not start in time"))
    }, 30_000)
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return
      buf += chunk.toString()
      const m = buf.match(/server listening on\s+(https?:\/\/[^\s]+)/)
      if (m) {
        settled = true
        clearTimeout(timer)
        resolve({ url: m[1]!, proc })
      }
    })
    proc.on("exit", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`server exited early (${code})`))
    })
  })
}

// --- trajectory extraction (opencode messages → ShareGPT) -------------------
interface ShareGPTTurn {
  from: "system" | "human" | "gpt" | "tool"
  value: string
  tool_calls?: Array<{ name: string; arguments: unknown }>
}

function toTrajectory(messages: any[], prompt: string): ShareGPTTurn[] {
  const turns: ShareGPTTurn[] = []
  if (system) turns.push({ from: "system", value: system })
  for (const msg of messages) {
    const role = msg.role
    const parts: any[] = msg.parts ?? []
    if (role === "user") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("\n").trim()
      if (text) turns.push({ from: "human", value: text })
      continue
    }
    if (role === "assistant") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("\n").trim()
      const toolParts = parts.filter((p) => p.type === "tool")
      const toolCalls = toolParts.map((p) => ({
        name: p.tool || p.name || "tool",
        arguments: p.state?.input ?? p.input ?? {},
      }))
      turns.push({
        from: "gpt",
        value: text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
      for (const p of toolParts) {
        const output = p.state?.output ?? p.output ?? ""
        turns.push({ from: "tool", value: typeof output === "string" ? output : JSON.stringify(output) })
      }
    }
  }
  return turns
}

// --- main -------------------------------------------------------------------
async function main() {
  // Load dataset
  const lines = fs
    .readFileSync(datasetFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  let prompts: string[] = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (typeof obj.prompt === "string") prompts.push(obj.prompt)
    } catch {
      /* skip malformed line */
    }
  }
  if (prompts.length > maxItems) prompts = prompts.slice(0, maxItems)

  // Resume: skip prompts already captured
  const done = new Set<string>()
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  if (resume && fs.existsSync(outputFile)) {
    for (const l of fs.readFileSync(outputFile, "utf8").split("\n")) {
      if (!l.trim()) continue
      try {
        const o = JSON.parse(l)
        if (o.prompt) done.add(o.prompt)
      } catch {
        /* ignore */
      }
    }
  }
  const todo = prompts.filter((p) => !done.has(p))
  console.log(`📊 ${prompts.length} prompts · ${done.size} already done · ${todo.length} to run · ${workers} workers`)
  if (!todo.length) {
    console.log("✅ Nothing to do.")
    return
  }

  console.log(`🚀 Booting server in ${directory} ...`)
  const { url, proc } = await bootServer(directory)
  const client = createOpencodeClient({ baseUrl: url })
  const out = fs.createWriteStream(outputFile, { flags: "a" })

  let index = 0
  let completed = 0
  let failed = 0
  const total = todo.length

  const runOne = async (prompt: string) => {
    let sid: string | undefined
    try {
      const created = await client.session.create({ body: { title: `datagen ${runName}` } })
      if (created.error || !created.data) throw new Error("session.create failed")
      sid = created.data.id
      const body: any = { parts: [{ type: "text", text: prompt }], maxTurns }
      if (model) body.model = model
      await client.session.prompt({ path: { id: sid }, body })
      const msgs = await client.session.messages({ path: { id: sid } })
      const messages = (msgs?.data as any[]) ?? []
      const conversations = toTrajectory(messages, prompt)
      out.write(
        JSON.stringify({ conversations, prompt, model: model ?? "auto", run: runName, ts: Date.now() }) + "\n",
      )
      completed++
    } catch (e) {
      failed++
      console.error(`  ✗ ${prompt.slice(0, 60)}… — ${e instanceof Error ? e.message : e}`)
    } finally {
      if (sid && !keepSessions) await client.session.delete({ path: { id: sid } }).catch(() => {})
      const n = completed + failed
      if (n % 5 === 0 || n === total) console.log(`  … ${n}/${total} (${completed} ok, ${failed} failed)`)
    }
  }

  // Simple worker pool
  const worker = async () => {
    while (true) {
      const i = index++
      if (i >= todo.length) return
      await runOne(todo[i]!)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))

  await new Promise<void>((r) => out.end(r))
  proc.kill()
  console.log(`\n✅ Done. ${completed} trajectories written to ${outputFile} (${failed} failed).`)
}

main().catch((e) => {
  console.error("datagen failed:", e)
  process.exit(1)
})
