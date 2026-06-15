# Deploy Hollycode Gateway 24/7 (Phase E)

Run the gateway on a $5 VPS so your agent is online from your phone around the
clock — independent of your laptop. The gateway boots the Hollycode server and
all your channels (Telegram, Discord, Slack, Signal, WhatsApp, Email) in one
long-lived process.

## 1. Configure locally first
The container runs non-interactively, so pair your channels on your machine:

```
bun run packages/gateway/bin/hollycode-gateway.ts --setup
```

This writes `~/.config/hollywood/gateway.json`. Copy it to the deploy volume:

```
mkdir -p deploy/data/.config/hollywood
cp ~/.config/hollywood/gateway.json deploy/data/.config/hollywood/
```

Put the code you want the agent to work on in `deploy/project/`.

## 2. Run with Docker Compose
From the repo root:

```
docker compose -f packages/gateway/docker-compose.yml up -d --build
```

The gateway starts, connects every configured channel, and restarts on reboot
(`restart: unless-stopped`). Logs:

```
docker logs -f hollycode-gateway
```

## 3. Channel notes on a server
- **Telegram / Discord / Slack / Signal**: work out of the box (outbound +
  long-poll/socket). Signal also needs the `signal-cli-rest-api` container.
- **WhatsApp / SMS / Teams**: need an inbound webhook. Expose port 3100 (already
  mapped in compose) behind your VPS's HTTPS reverse proxy (Caddy/nginx) and set
  that URL in the provider dashboard.
- **Email**: pure polling, no inbound port needed.

## 4. Without Docker (bare VPS)
```
curl -fsSL https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.sh | bash
hollycode-gateway --setup        # pair channels
hollycode-gateway                # starts in the background (survives logout)
```
Use `tmux`/`systemd` if you want it to survive a full reboot; the Docker path
above does that automatically.

## Serverless (future)
Modal / Daytona offer hibernate-on-idle persistence (near-zero cost between
sessions) — a later iteration; the Docker image is the portable baseline.
