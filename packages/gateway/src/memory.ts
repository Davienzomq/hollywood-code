// Tiered memory — the "hippocampus" of the gateway.
//
// Human-style memory in three layers:
//   SHORT   = the session context itself (compaction already handles it).
//   WORKING = a lean "## Auto-memory" section in AGENTS.md (capped, always in
//             the model's context — cheap and always visible).
//   LONG    = this store: every fact ever learned, kept OUT of the context in
//             SQLite FTS5, and injected per message via SELECTIVE RETRIEVAL —
//             only the few facts relevant to what the user just said (the
//             ChatGPT-Memories pattern). Usage counters feed curation, so
//             frequently-recalled facts stay fresh and stale ones fade.
//
// The curator (engine.curateMemory) moves overflow WORKING → LONG and rewrites
// the working section, keeping the in-context memory small forever.

// @ts-expect-error -- Bun provides "bun:sqlite" at runtime
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export interface MemoryFact {
  id: number
  scope: string
  text: string
  uses: number
}

export interface MemoryStore {
  /** Add a fact (deduped by exact text within the scope). Returns true if new. */
  add(scope: string, text: string): boolean
  /** Relevance search across the given scopes (FTS5 ranked). */
  search(scopes: string[], query: string, limit: number): MemoryFact[]
  /** Bump usage counters for retrieved facts (feeds curation/promotion). */
  touch(ids: number[]): void
  /** How many facts exist (optionally within one scope). */
  count(scope?: string): number
  /** Most recent facts of a scope (for /memory display). */
  recent(scope: string, limit: number): MemoryFact[]
  close(): void
}

export function openMemoryStore(dbPath?: string): MemoryStore {
  const file = dbPath ?? path.join(os.homedir(), ".hollycode", "memory.db")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(text, scope UNINDEXED, created UNINDEXED, uses UNINDEXED, lastUsed UNINDEXED)",
  )

  // Free text → safe FTS5 MATCH expression (same approach as search.ts): quote
  // every term and OR them so any word can match without syntax errors.
  const toMatch = (q: string) =>
    q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/["'*()^]/g, "").trim())
      .filter((t) => t.length > 1)
      .slice(0, 24) // long messages don't need every word in the query
      .map((t) => `"${t}"`)
      .join(" OR ")

  return {
    add(scope, text) {
      const clean = text.trim()
      if (!clean) return false
      const dup = db.query("SELECT rowid FROM mem WHERE scope = ? AND text = ?").get(scope, clean)
      if (dup) return false
      db.run("INSERT INTO mem (text, scope, created, uses, lastUsed) VALUES (?, ?, ?, 0, 0)", [
        clean,
        scope,
        Date.now(),
      ])
      return true
    },
    search(scopes, query, limit) {
      const match = toMatch(query)
      if (!match || !scopes.length) return []
      try {
        const ph = scopes.map(() => "?").join(", ")
        const rows = db
          .query(
            `SELECT rowid AS id, scope, text, uses FROM mem WHERE mem MATCH ? AND scope IN (${ph}) ORDER BY rank LIMIT ?`,
          )
          .all(match, ...scopes, limit) as Array<{ id: number; scope: string; text: string; uses: number }>
        return rows
      } catch {
        return []
      }
    },
    touch(ids) {
      if (!ids.length) return
      const now = Date.now()
      for (const id of ids) {
        try {
          db.run("UPDATE mem SET uses = uses + 1, lastUsed = ? WHERE rowid = ?", [now, id])
        } catch {
          /* fts5 update quirk — non-fatal */
        }
      }
    },
    count(scope) {
      try {
        const row = scope
          ? (db.query("SELECT COUNT(*) AS n FROM mem WHERE scope = ?").get(scope) as { n: number })
          : (db.query("SELECT COUNT(*) AS n FROM mem").get() as { n: number })
        return row?.n ?? 0
      } catch {
        return 0
      }
    },
    recent(scope, limit) {
      try {
        return db
          .query("SELECT rowid AS id, scope, text, uses FROM mem WHERE scope = ? ORDER BY created DESC LIMIT ?")
          .all(scope, limit) as MemoryFact[]
      } catch {
        return []
      }
    },
    close() {
      db.close()
    },
  }
}

// ── Markdown section helpers (working memory lives in AGENTS.md sections) ────

/** Extract the bullet lines of one `## Header` section. */
export function sectionBullets(content: string, header: string): string[] {
  const lines = content.split("\n")
  const start = lines.findIndex((l) => l.trim() === header)
  if (start === -1) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (/^#{1,6}\s/.test(l)) break
    if (l.trim().startsWith("- ")) out.push(l.trim().slice(2).trim())
  }
  return out
}

/** Remove one `## Header` section (header + body) from the content. */
export function removeSection(content: string, header: string): string {
  const lines = content.split("\n")
  const start = lines.findIndex((l) => l.trim() === header)
  if (start === -1) return content
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      end = i
      break
    }
  }
  lines.splice(start, end - start)
  return lines.join("\n").replace(/\n{3,}/g, "\n\n")
}

/** Replace (or append) a `## Header` section with the given bullets. */
export function writeSection(content: string, header: string, bullets: string[]): string {
  const without = removeSection(content, header)
  const body = `${header}\n${bullets.map((b) => `- ${b}`).join("\n")}\n`
  return (without.trimEnd() + (without.trim() ? "\n\n" : "") + body).trimStart()
}
