---
name: git-commit
description: Craft clean, conventional git commits and PRs. Use when the user asks to commit, stage changes, write a commit message, or open a pull request. Covers message style, splitting changes into logical commits, and PR descriptions.
---

# Git commit & PR craftsmanship

When committing or preparing a PR:

1. **Inspect first.** Run `git status` and `git diff` (and `git diff --staged`)
   to see exactly what changed before writing anything.
2. **Group logically.** If unrelated changes are mixed, stage and commit them
   separately so each commit tells one story.
3. **Message style** (Conventional Commits):
   - Subject: `<type>(<scope>): <imperative summary>` ≤ 72 chars
     (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`).
   - Blank line, then a body explaining *why*, not just *what*.
   - Reference issues (`Closes #123`) when relevant.
4. **Never** commit secrets, large binaries, or generated files — check the diff.
5. **PRs**: title mirrors the main commit; body has Summary / Changes / Testing
   sections. Keep it reviewable.

Only commit or push when the user asks. If on the default branch, suggest a
feature branch first.
