#!/usr/bin/env bash
# Hollycode installer (macOS / Linux) — downloads a tarball, no git required.
#   curl -fsSL https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.sh | bash
#
# Installs Bun if missing, downloads the repo to ~/.hollycode, runs `bun install`,
# and drops `hollycode` + `hollycode-remote` launchers into ~/.bun/bin.
set -euo pipefail

YELLOW='\033[0;33m'; GREEN='\033[0;32m'; GRAY='\033[0;2m'; NC='\033[0m'
step() { echo -e "${YELLOW}🎬 $1${NC}"; }

TARBALL="https://github.com/Davienzomq/hollywood-code/archive/refs/heads/main.tar.gz"
DEST="$HOME/.hollycode"
BUN_BIN="$HOME/.bun/bin"
BUN="$BUN_BIN/bun"

# 1. Bun
if [ ! -x "$BUN" ] && ! command -v bun >/dev/null 2>&1; then
  step "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
fi
[ -x "$BUN" ] || BUN="$(command -v bun)"

# 2. Download + extract (replaces any previous install)
command -v tar >/dev/null 2>&1 || { echo "tar is required."; exit 1; }
step "Downloading Hollycode..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$TARBALL" -o "$tmp/repo.tar.gz"
step "Extracting to $DEST..."
tar -xzf "$tmp/repo.tar.gz" -C "$tmp"
# Stop any running Hollycode first so it isn't using stale code mid-update
# (best-effort; on Windows a running hollycode.exe would also lock the dir).
if [ -x "$BUN" ] && [ -f "$DEST/packages/gateway/bin/hollycode-gateway.ts" ]; then
  "$BUN" run "$DEST/packages/gateway/bin/hollycode-gateway.ts" --stop 2>/dev/null || true
fi
# Preserve heavy downloaded assets across the wipe (ffmpeg, whisper, piper) so
# `hollycode-update` doesn't re-download them — they live inside $DEST.
preserve="$tmp/preserve"; mkdir -p "$preserve"
for a in ffmpeg whisper piper; do
  [ -e "$DEST/$a" ] && mv "$DEST/$a" "$preserve/$a" 2>/dev/null || true
done
rm -rf "$DEST"
mv "$tmp/hollywood-code-main" "$DEST"
# Restore the preserved assets into the fresh install (skips their re-download).
for a in ffmpeg whisper piper; do
  if [ -e "$preserve/$a" ]; then rm -rf "$DEST/$a"; mv "$preserve/$a" "$DEST/$a"; fi
done

# 3. Dependencies
step "Installing dependencies (this can take a minute)..."
# A second pass finishes linking if an optional native postinstall (e.g.
# tree-sitter-powershell without build tools) interrupted the first pass.
(cd "$DEST" && "$BUN" install)
(cd "$DEST" && "$BUN" install)

# 3b. Renamed runtime — a copy of the Bun runtime named "hollycode", so the
# gateway AND the opencode server it spawns (via process.execPath) both show as
# "hollycode" in process listings instead of the generic "bun".
RUNTIME="$DEST/hollycode"
cp "$BUN" "$RUNTIME" && chmod +x "$RUNTIME"

# 4. Launchers
step "Creating launchers in $BUN_BIN..."
mkdir -p "$BUN_BIN"

cat > "$BUN_BIN/hollycode" <<EOF
#!/usr/bin/env bash
# Hollycode launcher.
HOLLY_PROJ="\$(pwd)"
cd "\$HOME/.hollycode/packages/opencode"
if [ \$# -eq 0 ]; then
  exec "$RUNTIME" run --conditions=browser ./src/index.ts "\$HOLLY_PROJ"
else
  exec "$RUNTIME" run --conditions=browser ./src/index.ts "\$@"
fi
EOF
chmod +x "$BUN_BIN/hollycode"

cat > "$BUN_BIN/hollycode-remote" <<EOF
#!/usr/bin/env bash
# Hollycode — Remote Control (multi-channel gateway). First run: setup wizard.
# Uses the renamed runtime so the gateway + spawned server show as "hollycode".
HOLLY_PROJ="\$(pwd)"
exec "$RUNTIME" run "\$HOME/.hollycode/packages/gateway/bin/hollycode-gateway.ts" --directory "\$HOLLY_PROJ" "\$@"
EOF
chmod +x "$BUN_BIN/hollycode-remote"

# Update launcher — re-runs the installer to pull the latest version.
cat > "$BUN_BIN/hollycode-update" <<'EOF'
#!/usr/bin/env bash
# Hollycode — update to the latest version.
curl -fsSL https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.sh | bash
EOF
chmod +x "$BUN_BIN/hollycode-update"

# Uninstall launcher — stops the gateway, removes auto-start, deletes the install
# and the launchers. Bun is left installed (other tools may use it).
cat > "$BUN_BIN/hollycode-uninstall" <<EOF
#!/usr/bin/env bash
# Hollycode — uninstall.
echo "Removing Hollycode..."
"$BUN" run "\$HOME/.hollycode/packages/gateway/bin/hollycode-gateway.ts" --remove-startup 2>/dev/null || true
"$BUN" run "\$HOME/.hollycode/packages/gateway/bin/hollycode-gateway.ts" --stop 2>/dev/null || true
rm -rf "\$HOME/.hollycode"
rm -f "$BUN_BIN/hollycode" "$BUN_BIN/hollycode-remote" "$BUN_BIN/hollycode-update"
echo "Hollycode uninstalled. (Bun was left installed.)"
rm -f "$BUN_BIN/hollycode-uninstall"
EOF
chmod +x "$BUN_BIN/hollycode-uninstall"

# ffmpeg — sample frames from videos sent over chat so vision models can "watch"
# them. Best-effort; video analysis warns the user if it's missing.
if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -f "$DEST/ffmpeg/ffmpeg" ]; then
  echo "Installing ffmpeg (video frame analysis)..."
  mkdir -p "$DEST/ffmpeg"
  if [ "$(uname -s)" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then brew install ffmpeg >/dev/null 2>&1 || true; fi
  else
    ffx="/tmp/ffmpeg-$$.tar.xz"
    if curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o "$ffx" 2>/dev/null; then
      tar -xf "$ffx" -C /tmp 2>/dev/null || true
      ffbin="$(find /tmp -maxdepth 2 -name ffmpeg -type f 2>/dev/null | head -1)"
      if [ -n "$ffbin" ]; then cp "$ffbin" "$DEST/ffmpeg/ffmpeg" && chmod +x "$DEST/ffmpeg/ffmpeg"; fi
      rm -f "$ffx"
    fi
  fi
fi

# whisper.cpp — offline voice-note transcription (no API key). Best-effort, never
# fails the install. macOS: brew (symlinked so its dylibs resolve). Linux: build
# from source if git+make/cmake exist. Otherwise the bot falls back to a voice
# API key (set in the setup wizard). The gateway looks for $DEST/whisper/main.
if [ ! -f "$DEST/whisper/main" ] || [ ! -f "$DEST/whisper/model.bin" ]; then
  echo "Installing offline voice transcription (whisper.cpp)..."
  mkdir -p "$DEST/whisper"
  # model — small multilingual (~150MB); a larger one can be swapped in later
  if [ ! -f "$DEST/whisper/model.bin" ]; then
    curl -fsSL "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" -o "$DEST/whisper/model.bin" 2>/dev/null || true
  fi
  # binary → $DEST/whisper/main
  if [ ! -f "$DEST/whisper/main" ]; then
    if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      brew install whisper-cpp >/dev/null 2>&1 || true
      wbin="$(command -v whisper-cli 2>/dev/null || command -v whisper-cpp 2>/dev/null || true)"
      # symlink (not copy) so the Homebrew binary keeps its rpath to its dylibs
      if [ -n "$wbin" ]; then ln -sf "$wbin" "$DEST/whisper/main"; fi
    elif command -v git >/dev/null 2>&1 && { command -v make >/dev/null 2>&1 || command -v cmake >/dev/null 2>&1; }; then
      wsrc="/tmp/wcpp-$$"
      if git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$wsrc" >/dev/null 2>&1; then
        ( cd "$wsrc" && make -j >/dev/null 2>&1 ) \
          || ( cd "$wsrc" && cmake -B build >/dev/null 2>&1 && cmake --build build -j >/dev/null 2>&1 ) || true
        wbuilt="$(find "$wsrc" -maxdepth 3 \( -name main -o -name whisper-cli \) -type f -perm -u+x 2>/dev/null | head -1)"
        if [ -n "$wbuilt" ]; then cp "$wbuilt" "$DEST/whisper/main" && chmod +x "$DEST/whisper/main"; fi
      fi
      rm -rf "$wsrc"
    fi
  fi
  if [ -f "$DEST/whisper/main" ] && [ -f "$DEST/whisper/model.bin" ]; then
    echo "  Voice transcription ready (offline)."
  else
    echo "  Local whisper unavailable here — set a voice API key for transcription (setup wizard)."
  fi
fi

echo ""
echo -e "${GREEN}✅ Hollycode installed!${NC}"
echo ""
echo -e "   cd <your project>"
echo -e "   hollycode              ${GRAY}# start coding (free models included)${NC}"
echo -e "   hollycode-remote       ${GRAY}# pair your phone (Telegram, Discord, …)${NC}"
echo -e "   hollycode-update       ${GRAY}# update to the latest version${NC}"
echo -e "   hollycode-uninstall    ${GRAY}# remove Hollycode${NC}"
echo ""
case ":$PATH:" in
  *":$BUN_BIN:"*) ;;
  *) echo -e "${YELLOW}⚠  Add Bun to your PATH:  export PATH=\"\$HOME/.bun/bin:\$PATH\"${NC}" ;;
esac
