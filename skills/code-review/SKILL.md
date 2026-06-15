---
name: code-review
description: Review a code change for correctness, security, and clarity. Use when the user asks to review a diff, a PR, or recently changed files before merging. Focuses on real bugs first, then maintainability.
---

# Code review

Review the change the way a careful senior engineer would:

1. **Scope it.** Look at the diff (`git diff`, the PR, or the named files).
   Understand what the change is trying to do before judging how.
2. **Correctness first** — the highest-value findings:
   - Logic errors, off-by-one, wrong conditionals, unhandled nil/empty cases.
   - Race conditions, missing `await`, resource leaks (unclosed handles).
   - Broken error handling; swallowed exceptions.
3. **Security**: injection, unvalidated input, secrets in code, unsafe shell,
   auth/authorization gaps.
4. **Then quality**: dead code, duplication, unclear names, missing tests for
   new behavior.
5. **Report** concisely: group by severity (blocking / should-fix / nit). For
   each, give file:line and a concrete fix — not vague advice. If the change is
   solid, say so plainly instead of inventing nits.

Prefer fewer, high-confidence findings over a long list of speculation.
