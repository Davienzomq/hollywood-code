# Contributing to Hollycode

Thanks for your interest in contributing to Hollycode! Here are the kinds of changes most likely to be merged:

- Bug fixes
- Improvements to the stunt-double router (scoring, model dispatch)
- Support for new remote-control channels (Telegram, Discord, etc.)
- Additional LSP / formatter integrations
- Support for new AI providers
- Fixes for environment-specific quirks
- Documentation improvements

If you are unsure whether a PR would be accepted, open an issue first or look for issues labelled:

- [`help wanted`](https://github.com/Davienzomq/hollywood-code/issues?q=is%3Aissue+state%3Aopen+label%3Ahelp-wanted)
- [`good first issue`](https://github.com/Davienzomq/hollywood-code/issues?q=is%3Aissue+state%3Aopen+label%3A%22good+first+issue%22)
- [`bug`](https://github.com/Davienzomq/hollywood-code/issues?q=is%3Aopen+is%3Aissue+label%3Abug)

> [!NOTE]
> PRs that ignore these guidelines will likely be closed without review.

## Adding New Providers

New providers often require no code changes. If you want to add a provider, first check whether it is already supported via [models.dev](https://models.dev).

## Developing Hollycode

**Requirements:** Bun 1.3+

Clone the repo and install dependencies from the root:

```bash
git clone https://github.com/Davienzomq/hollywood-code.git
cd hollywood-code
bun install
```

Start the dev server:

```bash
bun dev
```

By default, `bun dev` runs Hollycode in the `packages/opencode` directory. To run it against a different directory:

```bash
bun dev <directory>
```

### Type-checking

```bash
bun turbo typecheck
```

### Building a standalone binary

```bash
./packages/opencode/script/build.ts --single
```

Then run it with:

```bash
./packages/opencode/dist/opencode-<platform>/bin/opencode
```

Replace `<platform>` with your platform (e.g., `darwin-arm64`, `linux-x64`).

### Key packages

- `packages/opencode` — core business logic and server (upstream opencode base)
- `packages/opencode/src/cli/cmd/tui/` — TUI, written in SolidJS with [opentui](https://github.com/sst/opentui)
- `packages/app` — shared web UI components (SolidJS)
- `packages/desktop` — Electron desktop wrapper
- `packages/gateway` — Hollycode additions: stunt-double router, multi-channel gateway, voice, datagen

> [!NOTE]
> If you change the API or SDK (e.g. `packages/opencode/src/server/server.ts`), run `./script/generate.ts` to regenerate the SDK and related files.

### Running the web app

1. Start the server: `bun dev serve`
2. Start the web app: `bun run --cwd packages/app dev`

The dev server opens at `http://localhost:5173`.

### Running the desktop app

```bash
bun run --cwd packages/desktop dev        # development
bun run --cwd packages/desktop build      # production build
bun run --cwd packages/desktop package    # package for distribution
```

## Pull Request Expectations

### Open an issue first

**All PRs must reference an existing issue.** Open an issue before opening a PR so we can triage and avoid duplicate work. Use `Fixes #123` or `Closes #123` in your PR description.

### General requirements

- Keep PRs small and focused on a single concern.
- Explain what the problem is and why your change fixes it.
- Check that the same functionality doesn't already exist in the codebase.

### UI changes

Include before/after screenshots or a short video.

### Logic changes

Explain how you tested the fix and how a reviewer can verify it.

### PR titles

Follow conventional commit prefixes:

| Prefix | Use for |
|---|---|
| `feat:` | new feature |
| `fix:` | bug fix |
| `docs:` | documentation |
| `chore:` | maintenance, deps |
| `refactor:` | code cleanup without behaviour change |
| `test:` | tests |

Add an optional scope for the affected package: `feat(gateway):`, `fix(desktop):`, etc.

### Style preferences

- **Functions:** keep logic inside a single function unless extraction adds real reuse.
- **Destructuring:** avoid unnecessary destructuring.
- **Control flow:** avoid `else` where possible.
- **Error handling:** prefer `.catch(...)` over `try/catch`.
- **Types:** use precise types; avoid `any`.
- **Variables:** prefer `const`; avoid `let`.
- **Naming:** short, single-word identifiers when they stay descriptive.
- **Runtime APIs:** use Bun helpers (`Bun.file()`, etc.) where they fit.

## Feature Requests

Open an issue describing the problem and your proposed approach before opening a feature PR. Wait for maintainer feedback before writing code.

## License

By contributing you agree that your changes will be licensed under the [MIT License](./LICENSE).

Hollycode is a fork of [opencode](https://github.com/anomalyco/opencode) (MIT). The original copyright is retained in LICENSE.
