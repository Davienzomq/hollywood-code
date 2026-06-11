# @opencode-ai/telegram — Hollywood Code remote control

Work with Hollywood Code from your phone over Telegram. Every prompt goes
through the normal session path, so the **router auto-casts the model per
message** — cheap doubles for small asks, the star for hard work — with no
extra setup.

## Setup (1 minute)

1. Message **@BotFather** on Telegram → `/newbot` → copy the token.
2. Message **@userinfobot** → copy your numeric user ID.
3. Create `packages/telegram/.env` (see `.env.example`):

```
HOLLYWOOD_TG_TOKEN=123456:ABC-your-bot-token
HOLLYWOOD_TG_ALLOWED_IDS=your-numeric-id
HOLLYWOOD_TG_DIRECTORY=C:\path\to\your\project
```

4. Run it (from the repo, with bun on PATH):

```bash
cd packages/telegram
bun run dev
```

5. Message your bot. `/start` for help.

## Commands

| Command | Action |
|---|---|
| (any text) | Work on your project; reply shows which model was cast |
| `/new` | Start a fresh session |
| `/status` | Show current session + directory |
| `/stop` | Abort the running task |
| `/start` `/help` | Help |

## Security

- **Allowlist is fail-closed**: only the IDs in `HOLLYWOOD_TG_ALLOWED_IDS` are
  served; everyone else is silently ignored. Empty list = refuse all.
- Token lives in `.env` (gitignored), never committed.
- Long-polling — no exposed ports or webhooks.

## Notes / roadmap (v2)

- Live tool progress is shown by editing a status message as tools complete.
- v2: inline-keyboard permission approvals, voice input, WhatsApp (secondary
  number — Baileys violates WhatsApp TOS, ban risk), Discord.
