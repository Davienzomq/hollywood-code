import { Cron } from "croner"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Phase C — scheduled automations. Cron jobs persisted to disk; on fire, run a
// prompt through the engine (unattended) and deliver the result to a channel.
// "every day 9am: summarize git log → me", running unattended.

export interface CronJob {
  id: string
  /** Cron expression, e.g. "0 9 * * *" (croner syntax). */
  cron: string
  /** The natural-language prompt to run. */
  prompt: string
  /** Where to deliver: the channel id + conversation id that created the job. */
  channelId: string
  conversationId: string
  /** Human label for listings. */
  createdAt: number
}

export interface SchedulerDeps {
  /** Run a prompt unattended; resolves with the reply text. */
  runPrompt: (channelId: string, conversationId: string, text: string) => Promise<string>
  /** Deliver text to a conversation on a channel (adapter.deliver). */
  deliver: (channelId: string, conversationId: string, text: string) => Promise<void>
  log: (scope: string, message: string) => void
}

export interface SchedulerHandle {
  add(job: Omit<CronJob, "id" | "createdAt">): CronJob
  remove(id: string): boolean
  list(): CronJob[]
  start(): void
  stop(): void
}

const JOBS_FILE = path.join(os.homedir(), ".hollywood-gateway-cron.json")

function loadJobs(): CronJob[] {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8").replace(/^﻿/, "")) as CronJob[]
  } catch {
    return []
  }
}

function saveJobs(jobs: CronJob[]) {
  try {
    const tmp = JOBS_FILE + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2))
    fs.renameSync(tmp, JOBS_FILE)
  } catch {
    /* best-effort */
  }
}

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  let jobs = loadJobs()
  const crons = new Map<string, Cron>()

  const fire = async (job: CronJob) => {
    deps.log("cron", `firing job ${job.id}: ${job.prompt.slice(0, 60)}`)
    try {
      const result = await deps.runPrompt(job.channelId, job.conversationId, job.prompt)
      // Heartbeat / watchdog pattern: a job whose agent reports nothing (empty or
      // "NOOP") stays silent — nothing is delivered. Lets a recurring job act as a
      // quiet heartbeat that only pings when there's actually something to say.
      const trimmed = result.trim()
      if (!trimmed || /^noop\b/i.test(trimmed)) {
        deps.log("cron", `job ${job.id} reported nothing — staying silent`)
        return
      }
      const text = `⏰ Scheduled: ${job.prompt}\n\n${result}`.trim()
      await deps.deliver(job.channelId, job.conversationId, text)
    } catch (err: any) {
      deps.log("cron", `job ${job.id} failed: ${err?.message ?? err}`)
      await deps
        .deliver(job.channelId, job.conversationId, `⏰ Scheduled job failed: ${err?.message ?? err}`)
        .catch(() => {})
    }
  }

  const schedule = (job: CronJob) => {
    try {
      // protect: true — croner skips a fire while the previous run of the SAME
      // job is still in flight (runPrompt is an LLM call that can outlast short
      // intervals; overlapping runs hammered the same session concurrently).
      const c = new Cron(job.cron, { protect: true }, () => void fire(job))
      crons.set(job.id, c)
    } catch (err: any) {
      deps.log("cron", `invalid cron "${job.cron}" for job ${job.id}: ${err?.message ?? err}`)
    }
  }

  return {
    add(partial) {
      // Validate the cron BEFORE persisting: an invalid expression used to be
      // saved + confirmed ("Scheduled ✓") but never fire — a silent lie. Throw
      // here so callers (/schedule, the cronjob agent tool) report it instead.
      const probe = new Cron(partial.cron, { paused: true }, () => {})
      probe.stop()
      let id = ""
      do {
        id = crypto.randomUUID().slice(0, 8)
      } while (jobs.some((j) => j.id === id))
      const job: CronJob = { ...partial, id, createdAt: Date.now() }
      jobs.push(job)
      saveJobs(jobs)
      schedule(job)
      return job
    },
    remove(id) {
      const before = jobs.length
      jobs = jobs.filter((j) => j.id !== id)
      saveJobs(jobs)
      const c = crons.get(id)
      if (c) {
        c.stop()
        crons.delete(id)
      }
      return jobs.length < before
    },
    list() {
      return [...jobs]
    },
    start() {
      for (const job of jobs) schedule(job)
      deps.log("cron", `scheduler started with ${jobs.length} job(s)`)
    },
    stop() {
      for (const c of crons.values()) c.stop()
      crons.clear()
    },
  }
}
