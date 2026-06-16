# INSTALLERS.md — Plan: distribute Hollycode like opencode (curl/npm/bun/brew/paru/scoop/choco)

Status: PLAN ONLY (not built, not committed). Goal: match opencode's install
channels. Repo: Davienzomq/hollywood-code, default branch `main`.

## How opencode actually works (verified in this repo)

- `packages/opencode/script/build.ts` cross-compiles the binary for 12 targets
  with `Bun.build({ compile: ... })` (linux/darwin/win32 × x64/arm64 × musl/avx2),
  writes `dist/<name>/bin/opencode` + a per-target `package.json` (os/cpu/libc).
  When `OPENCODE_RELEASE` is set it zips/tars each target and runs
  `gh release upload v<version> ... --repo $GH_REPO`.
- `packages/opencode/bin/opencode` is the npm shim: detects platform/arch/avx2/
  musl and runs the matching `opencode-<os>-<arch>[-baseline][-musl]` package
  binary from node_modules (classic optionalDependencies pattern).
- `packages/script/src/index.ts` (`Script`) computes version/channel from the
  npm registry + git branch; `OPENCODE_RELEASE` triggers the upload.
- The main npm package `opencode-ai` declares all platform packages as
  `optionalDependencies`; npm installs only the one matching the user's platform.
- curl/brew/scoop/choco/paru all just download the release artifacts.

**Everything depends on one foundation: a GitHub Release with compiled binaries.
That release is produced by CI (push workflow + cut a tag) — it cannot be made
"locally without committing".**

## Decision needed first: rebrand the binary identity?

Today `packages/opencode/package.json` name = `opencode`, npm main = `opencode-ai`,
binary = `opencode`. To ship `npm i -g hollycode` and `hollycode-*` artifacts,
either:
- (A) Rebrand to `hollycode` / `hollycode-ai` (touches build.ts target naming,
  bin/opencode base string, OPENCODE_* defines). Cleanest product, more work/risk.
- (B) Keep internal `opencode` artifacts, install the binary AS `hollycode` via
  the scripts (download URLs leak "opencode"). Lower risk, less branded.
Recommendation: (A) for a real product; do it carefully with a full build test in CI.

## Build order (each step unblocks the next)

### Step 1 — Release workflow (no account needed)
`.github/workflows/release.yml`, triggered on tag `v*`:
1. `actions/checkout`, setup Bun (oven-sh/setup-bun, version from root
   package.json `packageManager`).
2. `bun install`.
3. Build: `cd packages/opencode && OPENCODE_RELEASE=1 OPENCODE_VERSION=${tag#v}
   GH_REPO=Davienzomq/hollywood-code bun run script/build.ts` (needs `gh` —
   provided by `GITHUB_TOKEN`). Linux runner can cross-compile all Bun targets;
   `zip`/`tar` available on ubuntu-latest.
4. Create the GitHub Release first (`gh release create v<version> --notes ...`)
   so `gh release upload` in build.ts succeeds, OR have the workflow create it.
5. (Later) also publish npm + bump brew/scoop manifests in the same workflow.
Notes: build.ts also embeds the web UI (`packages/app build`) and pulls native
deps (`@opentui/core`, `@parcel/watcher`, `@ff-labs/fff-bun`) for all os/cpu —
keep those `bun install --os="*" --cpu="*"` lines. Expect first run to need
debugging (native modules, opentui worker path) — budget time.

### Step 2 — Binary install scripts (no account)
Rewrite `install.ps1` / `install.sh` to be binary-based (like opencode's):
1. Detect OS + arch (+ musl/avx2 on Linux, mirror the logic in
   `packages/opencode/bin/opencode`).
2. Download `https://github.com/Davienzomq/hollywood-code/releases/latest/download/
   <name>.zip|.tar.gz` and extract the binary.
3. Install it to `~/.bun/bin` (or `~/.local/bin`) as `hollycode` (+ keep the
   `hollycode-remote`/`-update`/`-uninstall` launcher wrappers, repointed to the
   binary instead of `bun run … src/index.ts`).
4. `install` URL stays `.../main/install.ps1|.sh` (already done).
KEEP the current source-based installer working until Step 1 produces a release,
or curl will 404. Switch over only after the first successful release.

### Step 3 — npm / bun / pnpm / yarn (needs npm account, free)
1. Decide name: `hollycode` (or `hollycode-ai`).
2. build.ts already emits per-platform packages in `dist/<name>/package.json` —
   publish each (`hollycode-windows-x64`, …) with `npm publish` from the workflow.
3. Main package `hollycode` with `bin` = the shim (adapt `bin/opencode`), and
   `optionalDependencies` listing every platform package at the same version.
4. `npm publish` all in the release workflow (needs `NPM_TOKEN` secret).
Result: `npm i -g hollycode`, `bun install -g hollycode`, etc.

### Step 4 — Homebrew tap (no account)
1. Create repo `Davienzomq/homebrew-tap`.
2. Add `Formula/hollycode.rb`: `url` → the macOS release tarball, `sha256`,
   `bin.install "hollycode"`. Support arm64 + x64 with `on_macos`/`Hardware::CPU`.
3. Release workflow updates the formula's url+sha on each release (commit to tap).
Result: `brew install Davienzomq/tap/hollycode`.

### Step 5 — AUR (needs AUR account + SSH key, free)
1. Create `hollycode-bin` on aur.archlinux.org.
2. `PKGBUILD` downloads the linux release tarball, installs to `/usr/bin/hollycode`.
3. `.SRCINFO` generated with `makepkg --printsrcinfo`. Bump pkgver on releases.
Result: `paru -S hollycode-bin`.

### Step 6 — Scoop bucket (no account) + Chocolatey (account + moderation)
- Scoop: repo `Davienzomq/scoop-bucket` with `hollycode.json` (url+hash → windows
  release zip). `scoop bucket add hollycode https://github.com/Davienzomq/scoop-bucket`.
- Choco: `hollycode.nuspec` + `tools/chocolateyinstall.ps1` (download release zip).
  `choco push` after `choco apikey`; expect manual moderation delay.

### Step 7 — Docker (no account, uses ghcr)
`packages/gateway/Dockerfile` exists. Add a workflow step to build+push
`ghcr.io/davienzomq/hollycode` on release (GITHUB_TOKEN has ghcr write).

## Contribution model (make Hollycode behave like a real OSS project)

Open source ≠ anyone can push. Only the owner + invited **collaborators** push
directly; everyone else **forks + opens a PR**; maintainer reviews/merges.
To set up (these are repo Settings / need admin via `gh`):
1. Branch protection on `main`: require PR before merge, require status checks
   (typecheck) to pass, optionally require 1 review.
   `gh api -X PUT repos/Davienzomq/hollywood-code/branches/main/protection ...`
2. Rebrand `CONTRIBUTING.md` (currently opencode's) → fork+PR flow for Hollycode.
3. Add `.github/ISSUE_TEMPLATE/` + `.github/PULL_REQUEST_TEMPLATE.md`.
4. Add collaborators manually in Settings → Collaborators when wanted.
Note: with branch protection requiring PRs, even you push via PRs (admins can
bypass if "include administrators" is off). Bug fixes from outsiders arrive as
PRs from their forks; CI runs on the PR; you merge.

## Accounts summary (all free)

- npm: free (public). AUR: free (+SSH key). Chocolatey: free (+manual review).
- Homebrew tap / Scoop bucket: just GitHub repos, no account.
- GitHub Releases/Actions/ghcr: free for public repos.

## Recommended sequence to execute later

1. Step 1 (workflow) + cut `v0.1.0` → first Release with binaries.
2. Step 2 (binary install scripts) → curl/irm work.
3. Step 4 (brew) — easy, no account.
4. Step 3 (npm) — when you can `npm login`.
5. Steps 5/6/7 (AUR/scoop/choco/docker) — last, niche/accounts.
6. Contribution model (branch protection + CONTRIBUTING) anytime.
