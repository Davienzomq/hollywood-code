<p align="center">
  <h1 align="center">🎬 Hollycode</h1>
</p>
<p align="center">The AI coding agent that casts the right model for every scene.</p>
<p align="center">
  <a href="https://github.com/Davienzomq/hollywood-code"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
  <a href="https://github.com/Davienzomq/hollywood-code"><img alt="Built on opencode" src="https://img.shields.io/badge/built%20on-opencode-blue?style=flat-square" /></a>
</p>

---

**Hollycode** is an open-source AI coding agent for your terminal — a fork of
[opencode](https://github.com/anomalyco/opencode) with three things built in:

- **🎬 The stunt-double router.** Every message is scored and *cast* to the
  cheapest model that can do the job — easy chat goes to the stunt doubles
  (Haiku / Flash / mini), hard reasoning goes to the star (Opus / Fable / GPT-5).
  Your frontier model stops paying to do the stunts. Run `/cost` to see what the
  doubles saved you.
- **📱 Remote control that lives where you do.** One command pairs the agent to
  **Telegram, Discord, Email, Slack, Signal or WhatsApp**. Permission requests
  arrive as Approve/Deny buttons, the bot runs as a real background daemon, and
  it can auto-start on boot so it survives reboots.
- **🧰 Native tools, free voice, real memory.** A built-in browser (Playwright)
  and image generation (FAL.ai) via MCP, a free fully-local voice loop (Piper
  TTS + whisper.cpp STT), full-text recall of past sessions, and auto-memory
  that quietly learns your project and preferences.

It keeps everything you expect from opencode — the TUI, 75+ providers, agents,
skills, MCP — and adds the Hollywood layer on top.

---

## Installation

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.ps1 | iex
```

**macOS / Linux**:

```bash
curl -fsSL https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.sh | bash
```

The installer needs no `git` — it downloads a ZIP/tarball, installs [Bun](https://bun.sh)
if missing, and drops the launchers onto your PATH. Then:

```bash
cd <your project>
hollycode                 # start coding in the terminal
hollycode-remote          # pair your phone (Telegram, Discord, …) — setup wizard
```

### Update

```bash
hollycode-update          # pull the latest version
```

> Re-running the install one-liner does the same thing. If you installed an
> **older** build that predates these launchers, run the install one-liner once
> — it drops `hollycode-update` and `hollycode-uninstall` for you.

### Uninstall

```bash
hollycode-uninstall       # stop the gateway, remove auto-start, delete the install
```

Uninstall stops the remote-control daemon, removes the OS auto-start entry, and
deletes `~/.hollycode` plus the launchers. Bun is left installed (other tools
may rely on it).

---

## Highlights

### The stunt-double router

Each message is scored on four dimensions — complexity, context size, quality
needed, and speed/cost pressure — and mapped to a tier:

| Score | Cast | Good for |
|---|---|---|
| low | stunt double (Haiku / Flash / mini) | classification, chat, formatting, simple Q&A |
| medium | supporting (Sonnet / Pro / GPT-5) | code, refactors, analysis, explanations |
| high | the star (Opus / Fable / GPT-5-codex) | architecture, deep reasoning, critical decisions |

It is **host-aware** — it only casts models the current host actually has — and
the reply tells you which model played the scene. Pin a model anytime with
`/model provider/id`, or go back to auto-casting with `/model auto`.

### Remote control (the gateway)

`hollycode-remote` runs a setup wizard, then hosts your agent over one or more
channels at once through a single embedded server:

- **Telegram · Discord · Email · Slack · Signal · WhatsApp**
- Permission and clarifying questions arrive as buttons in the chat.
- `/schedule` cron tasks, `/recall` past sessions, `/remember` facts, `/voice`
  to talk to it, `/tools` to toggle the browser/image tools, and ~45 commands.
- Optional **auto-start on boot** (Windows Task Scheduler / macOS launchd /
  Linux systemd) so the bot is always alive after a restart.

### Native tools (MCP)

```text
/tools browser on     # Playwright — navigate, click, read live pages (free, local)
/tools image on       # FAL.ai image generation (set FAL_KEY)
```

Both are real MCP servers, so they show up as native tools to the model in the
terminal and over every channel.

### Free, local voice

Send a voice message and the agent transcribes it; ask it to speak and it
replies with audio — entirely offline using **Piper** (TTS) and **whisper.cpp**
(STT), bundled by the installer. An API key (OpenAI/Groq) works too if you
prefer.

### Memory & skills

Full-text `/recall` over past sessions, silent auto-memory that curates
`AGENTS.md`, autonomous skill creation with a curator that archives unused ones,
and the full skills library.

### Datagen (for training)

`hollycode-datagen` runs a dataset of prompts through the agent in parallel and
records ShareGPT tool-calling trajectories — a dataset you can fine-tune on. See
[`packages/gateway/datagen-examples/`](packages/gateway/datagen-examples/).

---

## Agents

Like opencode, Hollycode ships two primary agents you switch with `Tab`:

- **build** — full-access agent for development work.
- **plan** — read-only agent for analysis and exploration.

Plus a **general** subagent for complex searches and multi-step tasks
(`@general`).

## Built on opencode

Hollycode is a fork of [opencode](https://github.com/anomalyco/opencode) and is
**not affiliated with or endorsed by the opencode team**. The upstream MIT
license is preserved in [LICENSE](./LICENSE); huge thanks to the opencode
authors for the foundation. The Hollywood layer (stunt-double router,
multi-channel gateway, native tools, local voice, datagen) is the part this
project adds.

## License

MIT — see [LICENSE](./LICENSE).
