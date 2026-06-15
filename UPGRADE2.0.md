# 🎬 Hollycode 2.0 — Upgrade Plan (inspired by Hermes Agent)

> **Goal:** turn Hollycode from a terminal coding agent with one chat channel
> (Telegram) into a **complete, always-on programming agent** that lives where
> the user does — many messaging platforms, voice, scheduled automations, a
> learning memory loop, and remote 24/7 backends — keeping its differentiator:
> the **stuntdouble cost router**.
>
> **Status (2026-06-13):** Phases A–F BUILT in `packages/gateway` (+ repo
> `skills/`, Docker files). Typecheck clean, smoke-tested. NOT committed
> (user hold). A=6 channels · C=cron (/schedule,/jobs,/unschedule) ·
> B=voice transcription · D=learning loop (/recall,/remember) ·
> E=Dockerfile+compose+DEPLOY.md · F=skills catalog+ATTRIBUTION+MCP docs.
> Live channel testing (Discord/Slack/etc) still pending before commit.

---

## License & approach (read first)

- The reference, **`hermes-agent` by Nous Research, is MIT-licensed** (verified
  in its `LICENSE`). MIT lets us reuse/adapt with attribution. (This is NOT the
  BSL-licensed "Hermes IDE" — different product. No BSL constraint here.)
- **But Hermes is Python**; Hollycode is **TypeScript on the opencode fork**.
  So we **port architecture and ideas**, not files. Keep an `ATTRIBUTION.md`
  crediting Nous Research / hermes-agent (MIT) for the patterns we adapt.
- **Fork hygiene (unchanged rule):** every feature lands as a minimal-diff
  module under `packages/*`, internal names stay `opencode`, only user-visible
  strings are Hollycode. Don't fork upstream files we can extend from outside.

---

## What Hollycode already has (don't rebuild)

| Capability | Where |
|---|---|
| Telegram remote control (permission buttons, daemon, /cost, /model auto) | `packages/telegram` |
| Slack bridge | `packages/slack` |
| Stuntdouble cost router + orchestration (parallel subagents) | `packages/opencode/src/hollywood`, `session/prompt.ts` |
| MCP support | opencode core (`/mcps`) |
| Skills (agentskills-style) | opencode core (`/skills`) |
| Plugin system | `packages/plugin` |
| Static memory (AGENTS.md / CLAUDE.md, global + project) | `session/instruction.ts` |
| Multi-provider models (75+) | opencode core |

## What Hermes has that we don't (the gap → this plan)

Many channels · voice · cron automations · a learning/memory loop · remote
24/7 backends · a richer plugin/skill catalog.

---

## Phase A — Unified Gateway + more channels (highest value)

**Hermes pattern:** one **gateway process** loads many **platform adapters**
(`gateway/platforms/`: telegram, discord, slack, whatsapp, signal, sms, email,
matrix, teams, wecom, feishu, dingtalk, imessage/bluebubbles…). Each adapter
inherits a `BasePlatformAdapter` and registers itself; the gateway handles
auth, routing, cron delivery, send_message, status — **zero core changes** to
add a platform (see `gateway/platforms/ADDING_A_PLATFORM.md`).

**Today in Hollycode:** `packages/telegram` and `packages/slack` are two
separate standalone processes — no shared abstraction.

**Plan:**
1. Create **`packages/gateway`** — one long-lived process that boots the
   embedded hollycode server once and hosts N channel adapters.
2. Define a **`ChannelAdapter` interface** (TS) mirroring Hermes' base:
   `start()`, `onMessage()`, `sendMessage()`, `sendChunked()`, permission
   prompt UI, status. Port the Telegram logic into the first adapter (keep all
   current features: permission buttons, /cost, /model auto, daemon, pidfile).
3. Reuse the **session-per-conversation** mapping and the auto-cast router for
   every channel for free (they all hit the same server pipeline — already
   proven for Telegram).
4. Add adapters incrementally. **DONE so far: Telegram ✓ (live-tested),
   Discord ✓, Email/IMAP+SMTP ✓.** Full channel menu (Hermes has ~24; ours is
   1 file each now that the contract exists):
   - **P1 next:** WhatsApp Cloud (official API, no ban risk), Slack (we already
     have packages/slack to fold in), Signal (signal-cli).
   - **P2:** SMS (Twilio), Microsoft Teams, Matrix.
   - **P3 / niche:** ntfy, IRC, LINE, Mattermost, Google Chat, Home Assistant.
   - **Skip for now:** WeChat / WeCom / DingTalk / Feishu / Yuanbao (China-market,
     heavy setup); iMessage/BlueBubbles (needs a Mac); WhatsApp via Baileys
     (QR + ban risk — use Cloud API instead).
5. One **`hollycode-gateway`** command + wizard (`--setup` adds channels):
   pick which channels to enable, paste tokens, pair — same one-command UX. ✓

**Why first:** directly answers "lives where the user does", and the adapter
abstraction makes every later channel cheap.

---

## Phase B — Voice

**Hermes:** voice-memo transcription (`agent/transcription_provider.py`,
`transcription_registry.py`, Whisper) + voice replies, per-channel.

**Plan:** a transcription module behind a provider interface (Whisper local,
or OpenAI/Groq transcription API as a cheap default). Gateway adapters that
receive audio (Telegram voice notes, WhatsApp/Discord audio) send it through
transcription → normal prompt. Optional TTS reply. Ship as a gateway add-on so
channels opt in.

---

## Phase C — Scheduled automations (cron)

**Hermes:** built-in cron scheduler (`cron/scheduler.py`, `jobs.py`,
blueprint/suggestion catalogs) delivering results to any platform — "daily
report", "nightly backup", "weekly audit", all in natural language, unattended.

**Plan:**
1. **`packages/scheduler`** (or a gateway module): cron-style jobs persisted to
   disk; each job = { schedule, prompt, deliver-to channel(s), project dir }.
2. On fire: open/continue a session, run the prompt (router casts it), deliver
   the result to the chosen channel.
3. Telegram/gateway commands: `/schedule "every day 9am: summarize git log →
   me"`, `/jobs`, `/job rm`. A small catalog of ready blueprints.
4. Pairs with the router: cheap recurring jobs run on doubles automatically.

---

## Phase D — Learning loop & memory (Hermes' signature)

**Hermes "closed learning loop":** agent-curated memory with periodic nudges;
**autonomous skill creation** after complex tasks; skills **self-improve**
during use; **FTS5 session search** + LLM summarization for cross-session
recall; pluggable memory backends (`plugins/memory/`: honcho, mem0, supermemory,
…); Honcho dialectic **user modeling**.

**Today in Hollycode:** memory is the static AGENTS.md the agent only *reads*.

**Plan (incremental, this is the deepest one):**
1. **Session search:** index past sessions (the SQLite store already exists at
   `~/.local/share/opencode`) with full-text search; expose a `recall` tool +
   `/recall` so the agent can search its own history. (FTS5 is built into the
   bundled SQLite.)
2. **Memory-write tool:** let the agent append durable facts to
   `AGENTS.md`/a memory file on its own (with the existing permission gate),
   plus a periodic "should I remember anything?" nudge after big tasks.
3. **Autonomous skill creation:** after a complex multi-step task, offer to
   distill it into a reusable skill in the skills dir (agentskills standard,
   which opencode already supports).
4. **User model (optional):** a lightweight profile file the agent maintains
   ("who you are" across sessions). Honcho integration is optional/pluggable.

---

## Phase E — Remote, always-on backends (24/7)

**Hermes:** six terminal backends — local, **Docker, SSH, Singularity, Modal,
Daytona** — Modal/Daytona give serverless persistence (hibernate when idle,
wake on demand, ~$0 between sessions). "Not tied to your laptop."

**Today in Hollycode:** the Telegram bot runs locally (daemon survives window
close, but not a reboot, and it's your PC).

**Plan:**
1. **Docker image** for the gateway+server (compose file) → run on a $5 VPS so
   the agent is online 24/7 independent of your PC.
2. **Remote execution backend** abstraction: run tool/shell commands in
   local | Docker | SSH targets. (Modal/Daytona serverless = later, research.)
3. Document a one-page "deploy Hollycode on a VPS" guide; the gateway already
   speaks to phones, so a cloud gateway = true always-on agent.

---

## Phase F — Richer plugins, MCPs, skills catalog

**Hermes ships:** plugins (browser, context_engine, **memory**, image_gen,
video_gen, kanban, web, spotify, observability…), optional MCPs (linear, n8n),
and large built-in + optional **skill catalogs** (devops, research, email,
github, software-development, social-media, finance, security, web-dev…).

**Portability — confirmed by inspection:**
- **Skills = portable almost as-is.** Hermes skills are `SKILL.md` files with
  YAML frontmatter — the SAME agentskills.io standard opencode already reads.
  **~170 skills** total (built-in + optional), MIT-licensed. ~129 are pure
  markdown (drop into the skills dir, extra frontmatter fields like
  version/author are ignored by opencode); ~41 ship helper scripts (.sh/.py)
  that need testing (some assume Hermes' Python env). → **copy + attribute.**
- **MCPs = reusable directly.** MCP is language-agnostic and opencode already
  supports it; Hermes' optional MCPs (linear, n8n) plug in as-is.
- **Plugins & connectors = port, don't copy.** Hermes plugins/adapters are
  Python; we re-implement the logic in TS on opencode's plugin system. Ideas/
  architecture are MIT-OK to adapt.

**Plan:** lean on what opencode already has (plugin system, MCP, skills) and
**curate a Hollycode catalog**:
1. Port the high-value Hermes skill packs (github, devops, research,
   software-development, note-taking) — start with the pure-markdown ones,
   credit Nous Research (MIT). Audit the script-backed ones before bundling.
2. Document + preconfigure popular MCPs (linear, n8n, browser) for one-command
   enable.
3. A couple of native TS plugins that show off the brand (browser tool,
   image-gen), exposed in TUI + every gateway channel.

---

## Suggested execution order

1. **Phase A** (gateway + Discord/WhatsApp-Cloud/Email) — biggest "lives where
   you do" win, unlocks everything else.
2. **Phase C** (cron) — small, high wow-factor, pairs with the router.
3. **Phase B** (voice) — quick add-on once the gateway exists.
4. **Phase D** (learning loop) — the deepest differentiator; do it in slices
   (session search → memory-write → skill creation).
5. **Phase E** (24/7 backends) — Docker/VPS first, serverless later.
6. **Phase F** (catalog) — ongoing, parallel to everything.

## Standing rules
- PLAN ONLY until the user says go; build phase by phase, test each live
  (Telegram is the proving ground), commit after the user confirms.
- Credit hermes-agent (MIT, Nous Research) in `ATTRIBUTION.md` for adapted
  patterns. Keep the fork mergeable (minimal diffs, internal names = opencode).
- Everything public stays in English; the router stays the heart of Hollycode.
