# Hollycode Gateway — 24/7 container (Phase E).
# Build from the REPO ROOT (the gateway spawns the opencode server from the
# monorepo): docker build -f packages/gateway/Dockerfile -t hollycode-gateway .
FROM oven/bun:1

WORKDIR /app
COPY . .
RUN bun install || true

# Config + sessions live under $HOME so a mounted volume persists them.
ENV HOME=/data
ENV HOLLYWOOD_ROUTER=on

WORKDIR /app/packages/gateway

# Runs in the foreground (the container is the daemon). Provide a configured
# /data/.config/hollywood/gateway.json and mount your code at /project.
CMD ["bun", "run", "bin/hollycode-gateway.ts", "--foreground", "--directory", "/project"]
