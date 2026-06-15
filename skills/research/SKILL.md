---
name: research
description: Research a topic or unfamiliar codebase/library and produce a grounded summary. Use when the user asks to investigate, compare options, understand how something works, or gather current information before deciding.
---

# Research & summarize

1. **Clarify the question** in one line before digging — what decision does this
   research serve?
2. **Prefer primary sources**: official docs, the actual source code, release
   notes. For anything that changes over time (APIs, versions, prices), retrieve
   current info rather than relying on memory.
3. **For a codebase**: map the entry points and the relevant modules first, then
   read the specific code paths. Cite `file:line`.
4. **Synthesize, don't dump**: lead with the answer, then the supporting
   evidence. Note trade-offs and what you're unsure about.
5. **Output**: a short summary up top, then bullet findings with sources/links.
   If options are compared, give a recommendation, not just a table.

Be honest about gaps — say "couldn't verify X" instead of guessing.
