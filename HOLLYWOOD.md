# 🎬 Hollywood Code

Private fork of [opencode](https://github.com/anomalyco/opencode) (MIT) that
turns the [stuntdouble](https://github.com/Davienzomq/stuntdouble) skill into a
native harness feature: **the model is selected automatically, per message,
before the LLM call** — no instructions for the model to follow, no manual
switching.

> Your frontier model is the star — now the casting happens in the harness.

## The idea

| Message | What Hollywood Code does |
|---|---|
| Casual question, small talk | routes to the cheapest model automatically |
| Everyday coding task | routes to the mid-tier model |
| Large decomposable task | plans like stuntdouble, runs parts on opencode's native subagents (per-agent models), strongest model verifies |

Scoring: the stuntdouble 4-dimension heuristic (complexity 40%, context 20%,
quality 25%, speed/cost pressure 15%) implemented as a zero-cost local
classifier in the request pipeline.

## Architecture plan

1. **Router module** — injected at the point where the server resolves
   provider/model per request (opencode resolves the model per request, so the
   override is surgical). Heuristic scoring first; optional mini-model scorer
   later.
2. **Config** — `hollywood.router: on | off`, tier→model mapping per provider,
   manual override escape hatch.
3. **Orchestration (phase 2)** — map decomposable tasks to opencode's native
   subagents + parallel sessions; verification pass on the strongest model.
4. **Branding** — minimal diff (TUI strings only) to keep upstream rebases
   painless. Remote `upstream` = anomalyco/opencode.

## Status

- [x] Fork cloned, upstream remote wired (branch `dev`)
- [x] Explore the codebase: model resolution found at `session/prompt.ts`
  `createUserMessage` — chain `input.model ?? ag.model ?? currentModel()`
- [x] Router prototype: `src/hollywood/router.ts` (pure scorer + per-provider
  tier candidates) wired into the chain as `?? routed ??`. Downgrade-only;
  explicit user choice (TUI pick, agent model, session model) always wins;
  primary non-hidden agents only; `HOLLYWOOD_ROUTER=off` to disable.
  Typecheck clean, 10 unit tests green (`test/hollywood/router.test.ts`).
- [x] Live smoke test (Codex OAuth, headless server + API): "oi" auto-routed
  to `gpt-5.4-mini` with zero manual selection — the double works. Explicit
  user choice respected (TUI pick stayed on 5.5). Failsafe fallback verified.
- [x] Rebrand layer 1a: TUI wordmark OPENCODE → HOLLY CODE (`tui/src/logo.ts`)
- [x] **Star-drift bug FIXED** (cross-agent session: Codex GPT-5.5 confirmed
  the diagnosis + found the second stickiness source — the `!current?.model`
  guard self-disabled after the first routed message via ModelSwitched
  persistence — and drafted the fix; finished/corrected/live-verified by
  Claude). Router owns ALL tiers with explicit candidates; auto mode
  re-scores every prompt; `input.model`/agent model = manual pin. Live proof
  in one session: "oi" → gpt-5.4-mini (double), architecture spec → gpt-5.5
  (star returns).
- [x] Integration tests (Codex's item 6): `test/hollywood/prompt-routing.test.ts`
  — oi→low double, architecture→star (even after a low turn), manual pick
  wins, missing candidates fall back. 4 green; upstream suites untouched.
- [x] STUNTDOUBLE ORCHESTRATION LAYER: primary agents get the orchestration
  system prompt (`ORCHESTRATION_PROMPT` in `hollywood/router.ts`, injected in
  `prompt.ts` runLoop) — decompose big tasks into parallel task-tool
  subagents, close with a star verification subtask. The task tool now omits
  the model for unpinned subagents (`tool/task.ts`) so the router casts EACH
  subtask by its own content. Router off = upstream inherit behavior.
- [x] `hollywood` global command: `%USERPROFILE%\.bun\bin\hollywood.cmd` —
  run from any folder (cwd = project). `hollywood --version` works.
- [x] UNIVERSAL PROVIDERS: (a) unknown providers get a low-tier double out of
  the box via `provider.getSmallModel` (priority lists for dozens of
  providers + `cfg.small_model` + plugin hook); mid/high fall back to the
  star. (b) `HOLLYWOOD_TIERS` env var (JSON) defines/overrides casting tables
  per provider — works for Mistral, Ollama, anything.
- [ ] Tier→model config in opencode.json (nicer surface than the env var —
  needs a `hollywood` key in the core config schema)
- [ ] Compile `hollycode.exe` (bun build --compile) so Task Manager shows the
  brand; optional installer for Apps & Programs
- [ ] Rebrand layer 2: remaining UI strings
- [ ] Phase 2: native subagent orchestration
- [ ] Windows note: kill servers by PID/port — stopping the wrapper leaves a
  zombie `bun` holding the port (cost a debugging hour).

## License

Upstream is MIT — original copyright notices are preserved. This fork is
private and for personal use for now.
