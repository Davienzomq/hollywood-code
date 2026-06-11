# 🎬 Hollywood Code — Extension Plan (v2 features)

Baseline: tag `v0.1-router-working` / branch `backup/working-2026-06-11`
(router + orchestration + universal providers, live-tested). This plan covers
the next two feature waves: **remote control from the phone** and **Claude
Code command parity**.

---

## Phase 1 — Remote Control (work from your phone)

### Research verdict (Hermes vs OpenClaw)

| Project | License | Lesson |
|---|---|---|
| **OpenClaw** (ex-Clawdbot/Moltbot, ~116k stars) | MIT ✅ | Gateway + channel-adapter architecture; Telegram via grammY (official Bot API, long-polling); WhatsApp via Baileys = **TOS violation, real ban risk**, QR pain; pairing-code allowlist security |
| **Hermes IDE** | BSL 1.1 ⚠️ NOT open source — **do not copy code**, ideas only | "Telegram is a phone-shaped terminal into your local session"; dual auth (bot token + pairing code); auto-approve toggle for permission gates |
| **opencode ecosystem** | — | `packages/slack` already bridges chat→sessions via the SDK (our blueprint!); community ref: `grinev/opencode-telegram-bot` (grammY + localhost:4096 + SSE streaming) — closest existing implementation, study before writing |

### v1 decision: Telegram first

- **Why**: official Bot API (zero ban risk), grammY is TypeScript (our stack),
  long-polling = no exposed ports/webhooks, BotFather setup in 1 minute.
- **WhatsApp**: v2 only, secondary number, accept Baileys ban risk.

### v1 architecture (~300 lines, decoupled from core)

```
Your phone (Telegram app)
   ↕ Bot API (long-polling)
grammY bot — new package `packages/telegram` (mirror packages/slack structure)
   ↕ SDK / HTTP: POST /session · POST /session/:id/prompt_async ·
     GET /session/:id/message + SSE event stream
hollycode serve (our fork, router + orchestration INCLUDED for free —
   remote prompts go through createUserMessage → auto-cast like any prompt!)
```

Behaviors:
- Map `chat_id → session_id` (JSON file or sqlite); `/new` resets.
- Stream progress: typing action + one status message edited in place
  (`editMessageText`) per tool event; final answer chunked at 4096 chars.
- Telegram commands: `/new`, `/sessions`, `/status`, `/stop`.

Security minimums (single-user):
1. `HOLLYWOOD_TG_ALLOWED_IDS` — silently ignore everyone else
2. Bot token via env (`HOLLYWOOD_TG_TOKEN`), never committed
3. `OPENCODE_SERVER_PASSWORD` between bridge and serve if not localhost
4. Optional pairing code on first contact (OpenClaw pattern)

v2 backlog: permission approval via inline keyboards (ccgram pattern),
WhatsApp adapter, voice input (Whisper), scheduled `/task` prompts,
Discord adapter.

### Phase 1 tasks
1. [ ] `packages/telegram` skeleton (copy packages/slack layout) + grammY
2. [ ] Session mapping + prompt bridge + SSE streaming to edited messages
3. [ ] Allowlist + env config + `hollycode telegram` CLI subcommand
4. [ ] Live test: prompt from phone → router casts → reply on phone
5. [ ] Windows service / background mode so it survives terminal close

---

## Phase 2 — Claude Code command parity (one by one)

Our fork already has 31 commands (incl. differentiators CC lacks: /models
multi-provider, /connect, /variants, /timeline, /unshare, /warp). The gap,
prioritized:

### P1 — first batch (high value, easy/medium)
| Command | Notes |
|---|---|
| `/cost` `/usage` | token counts exist in session store; add per-provider pricing table + display. Pairs beautifully with the router ("how much did the doubles save?") |
| `/context` | visualize context window usage |
| `/model <name>` | direct-arg switch (today only `/models` picker) — include `/model auto` to re-enable Hollywood routing after a manual pin! |
| `/compact [instructions]` | add optional focus arg to existing compact |
| `/init` | bootstrap a project memory file (AGENTS.md) |
| `/memory` | edit project memory files |
| `/resume <id>` | direct-arg resume (today only picker) |
| `/plan` | plan mode toggle (read-only agent exists — wire as mode) |
| `/rewind` | checkpoint rollback (extend /undo) |
| `/mcp` args | extend /mcps with reconnect/enable/disable |

### P2 — second batch
`/goal` (loop until condition — natural fit with orchestration), `/effort`,
`/permissions`, `/hooks`, `/branch`, `/review`, `/security-review`,
`/background` + `/tasks`, `/advisor`, `/add-dir`, `/doctor`, `/recap`.

### P3 — deferred (cloud infra / platform-specific)
`/schedule`, `/teleport`, `/remote-control` (our Phase 1 IS this, better),
`/batch`, `/autofix-pr`, `/voice`, `/sandbox`, `/ide`, `/statusline`.

---

## Standing rules
- Every feature lands as a minimal-diff module (upstream sync stays painless)
- Backup tag before each phase; pre-push hook keeps the monorepo typechecked
- Hermes IDE is BSL-licensed: ideas OK, code copying NOT OK. OpenClaw is MIT.
- All public-facing content in English.
