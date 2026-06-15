# Hollycode datagen (batch trajectory generator)

Generate tool-calling **trajectories** for training/fine-tuning — the same idea
as Hermes' `batch_runner.py`, but driven by Hollycode's embedded opencode server
so the trajectories use the real tools and the stunt-double router.

## What it does

1. Reads a dataset of prompts (one JSON object per line, with a `"prompt"` field).
2. Runs each prompt in a **fresh session**, in parallel, to completion.
3. Records the full trajectory — `system → human → gpt (+tool_calls) → tool → …` —
   as a **ShareGPT-format** JSONL line.
4. Writes everything to `data/<run-name>/trajectories.jsonl` (resumable).

## Usage

```bash
# from the repo (bun on PATH)
bun run packages/gateway/bin/hollycode-datagen.ts \
  --dataset packages/gateway/datagen-examples/example_tasks.jsonl \
  --run-name my_run \
  --workers 3

# or, once installed, via the bin:
hollycode-datagen --dataset tasks.jsonl --run-name my_run --resume
```

## Options

| Flag | Meaning |
|---|---|
| `--dataset <file>` | JSONL of `{"prompt": "..."}` (required) |
| `--run-name <name>` | Output dir `data/<name>/trajectories.jsonl` |
| `--output <file>` | Explicit output path (overrides `--run-name`) |
| `--directory <dir>` | Project directory the agent works in (default: cwd) |
| `--workers <n>` | Parallel workers (default 3) |
| `--model <p/m>` | Pin a model `providerID/modelID` (default: router/auto) |
| `--system <text>` | Ephemeral system prompt prepended to every task |
| `--max-items <n>` | Only run the first N prompts |
| `--max-turns <n>` | Turn hint passed to the agent (default 30) |
| `--resume` | Skip prompts already present in the output |
| `--keep-sessions` | Don't delete sessions after capture (debugging) |

## Output format (ShareGPT)

```json
{
  "conversations": [
    {"from": "system", "value": "..."},
    {"from": "human", "value": "the prompt"},
    {"from": "gpt", "value": "assistant text", "tool_calls": [{"name": "read", "arguments": {"filePath": "..."}}]},
    {"from": "tool", "value": "tool output"},
    {"from": "gpt", "value": "final answer"}
  ],
  "prompt": "the prompt",
  "model": "auto",
  "run": "my_run",
  "ts": 1718412345678
}
```

This is a developer/training feature — it is **not** exposed in Telegram or the
TUI chat. Run it from the CLI when you want to build a dataset.
