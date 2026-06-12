# Hollywood Code — Remote Control (Telegram)

Work on your project from your phone. Uses the same model as your terminal.

## Setup (one command)

From any terminal, in the folder of the project you want to control:

```
hollycode-remote
```

**First run** launches an interactive wizard:

```
🎬 Hollywood Code — Remote Control Setup
1. Create a bot with @BotFather (/newbot) and paste the token here:
   > <token>
   ✓ Connected as @your_bot
2. Send /start to @your_bot from your phone...
   📱 You (ID 12345) wants to pair. Approve? [y/n] y
   ✓ Paired!
3. Config saved. ⚡ Remote control online as @your_bot
```

**Next runs** skip the wizard and go straight online. Keep the window open
while you use it (it's the bridge server). `Ctrl+C` stops it cleanly.

Config is saved to `~/.config/hollywood/telegram.json`. Power users can skip
the wizard with env vars (`HOLLYWOOD_TG_TOKEN`, `HOLLYWOOD_TG_ALLOWED_IDS`,
`HOLLYWOOD_TG_DIRECTORY`, `HOLLYWOOD_TG_MODEL`).

## On your phone

| Send | Does |
|---|---|
| any text | the agent works on your project; reply shows which model was used |
| `/new` | start a fresh session |
| `/status` | show the current session + directory |
| `/stop` | abort the running task |

## Installation (from source)

```bash
cd packages/telegram
bun link
hollycode-remote --directory /path/to/your/project
```

## Options

```
hollycode-remote --model anthropic/claude-sonnet-4-5 --directory ./my-project
```

- `--model <provider/id>` — override the model for Telegram prompts
- `--directory <path>` — project directory (default: current dir)

## Security

Fail-closed allowlist: only paired Telegram IDs are answered; everyone else is
silently ignored. The token lives only in your local config, never committed.

## Notes / v2 backlog

- v2: permission approval via inline keyboards, voice input, WhatsApp/Discord
  adapters, a `--daemon` background mode, and a `/remote-control` TUI shortcut.
