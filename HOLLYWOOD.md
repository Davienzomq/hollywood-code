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
- [ ] Explore the codebase: locate model resolution in the request flow
- [ ] Router prototype
- [ ] Tier→model config
- [ ] Rebrand
- [ ] Phase 2: native subagent orchestration

## License

Upstream is MIT — original copyright notices are preserved. This fork is
private and for personal use for now.
