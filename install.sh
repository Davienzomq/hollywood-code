#!/usr/bin/env bash
# Hollycode installer (macOS / Linux) — clone-based, works without prebuilt binaries.
#   curl -fsSL https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.sh | bash
#
# Installs Bun if missing, clones the repo to ~/.hollycode, runs `bun install`,
# and drops `hollycode` + `hollycode-remote` launchers into ~/.bun/bin.
set -euo pipefail

YELLOW='\033[0;33m'; GREEN='\033[0;32m'; GRAY='\033[0;2m'; NC='\033[0m'
step() { echo -e "${YELLOW}🎬 $1${NC}"; }

REPO="https://github.com/Davienzomq/hollywood-code"
DEST="$HOME/.hollycode"
BUN_BIN="$HOME/.bun/bin"
BUN="$BUN_BIN/bun"

# 1. Bun
if [ ! -x "$BUN" ] && ! command -v bun >/dev/null 2>&1; then
  step "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
fi
[ -x "$BUN" ] || BUN="$(command -v bun)"

# 2. Git
command -v git >/dev/null 2>&1 || { echo "git is required. Install it and re-run."; exit 1; }

# 3. Clone or update
if [ -d "$DEST/.git" ]; then
  step "Updating existing install at $DEST..."
  git -C "$DEST" pull --ff-only
else
  step "Cloning Hollycode to $DEST..."
  git clone --depth 1 "$REPO" "$DEST"
fi

# 4. Dependencies
step "Installing dependencies (this can take a minute)..."
(cd "$DEST" && "$BUN" install)

# 5. Launchers
step "Creating launchers in $BUN_BIN..."
mkdir -p "$BUN_BIN"

cat > "$BUN_BIN/hollycode" <<EOF
#!/usr/bin/env bash
# Hollycode launcher.
HOLLY_PROJ="\$(pwd)"
cd "\$HOME/.hollycode/packages/opencode"
if [ \$# -eq 0 ]; then
  exec "$BUN" run --conditions=browser ./src/index.ts "\$HOLLY_PROJ"
else
  exec "$BUN" run --conditions=browser ./src/index.ts "\$@"
fi
EOF
chmod +x "$BUN_BIN/hollycode"

cat > "$BUN_BIN/hollycode-remote" <<EOF
#!/usr/bin/env bash
# Hollycode — Remote Control (Telegram). First run: interactive setup wizard.
HOLLY_PROJ="\$(pwd)"
exec "$BUN" run "\$HOME/.hollycode/packages/telegram/bin/hollycode-remote.ts" --directory "\$HOLLY_PROJ" "\$@"
EOF
chmod +x "$BUN_BIN/hollycode-remote"

echo ""
echo -e "${GREEN}✅ Hollycode installed!${NC}"
echo ""
echo -e "   cd <your project>"
echo -e "   hollycode              ${GRAY}# start coding (free models included)${NC}"
echo -e "   /remote-control        ${GRAY}# pair your phone over Telegram${NC}"
echo ""
case ":$PATH:" in
  *":$BUN_BIN:"*) ;;
  *) echo -e "${YELLOW}⚠  Add Bun to your PATH:  export PATH=\"\$HOME/.bun/bin:\$PATH\"${NC}" ;;
esac
