// bun:sqlite is a Bun runtime built-in; bun-types isn't installed in this
// package, so silence the resolver — the module exists at runtime.
// @ts-expect-error -- Bun provides "bun:sqlite" at runtime
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Real full-text search over past sessions (Phase D) using SQLite FTS5 — the
// same engine Hermes uses for cross-session recall. Replaces the old substring
// scan: proper ranking + highlighted snippets.

export interface RecallHit {
  sessionId: string
  title: string
  snippet: string
}

export interface RecallIndex {
  /** Replace the indexed text for one session. */
  put(sessionId: string, title: string, content: string): void
  /** FTS5 MATCH query → ranked hits with snippets. */
  search(query: string, limit: number): RecallHit[]
  close(): void
}

export function openRecallIndex(): RecallIndex {
  const dir = path.join(os.homedir(), ".hollycode")
  fs.mkdirSync(dir, { recursive: true })
  const db = new Database(path.join(dir, "recall.db"))
  db.run("CREATE VIRTUAL TABLE IF NOT EXISTS recall USING fts5(sessionId UNINDEXED, title, content)")

  // Turn a free-text query into a safe FTS5 MATCH expression: OR the terms so
  // any word can match, and quote each term to avoid FTS5 syntax errors.
  const toMatch = (q: string) =>
    q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/["']/g, "").trim())
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(" OR ")

  return {
    put(sessionId, title, content) {
      db.run("DELETE FROM recall WHERE sessionId = ?", [sessionId])
      db.run("INSERT INTO recall (sessionId, title, content) VALUES (?, ?, ?)", [sessionId, title, content])
    },
    search(query, limit) {
      const match = toMatch(query)
      if (!match) return []
      try {
        const rows = db
          .query(
            "SELECT sessionId, title, snippet(recall, 2, '«', '»', '…', 14) AS snip " +
              "FROM recall WHERE recall MATCH ? ORDER BY rank LIMIT ?",
          )
          .all(match, limit) as Array<{ sessionId: string; title: string; snip: string }>
        return rows.map((r) => ({ sessionId: r.sessionId, title: r.title || r.sessionId, snippet: r.snip }))
      } catch {
        return []
      }
    },
    close() {
      db.close()
    },
  }
}
