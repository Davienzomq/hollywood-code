import type { Session } from "@opencode-ai/sdk/v2/client"
import { Component, createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { displayName, projectForSession, sortedRootSessions } from "@/pages/layout/helpers"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { DateTime } from "luxon"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RecallRecord = {
  session: Session
  projectName: string
  directory: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesQuery(record: RecallRecord, query: string): boolean {
  const title = sessionTitle(record.session.title) ?? record.session.id
  return `${title} ${record.projectName}`.toLowerCase().includes(query)
}

function recallKey(record: RecallRecord): string {
  return `${pathKey(record.directory)}:${record.session.id}`
}

function formatUpdated(session: Session): string {
  const ms = session.time.updated ?? session.time.created
  return DateTime.fromMillis(ms).toRelative() ?? ""
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const DialogRecall: Component = () => {
  const dialog = useDialog()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
  const sync = useServerSync()

  const [query, setQuery] = createSignal("")
  let inputRef: HTMLInputElement | undefined

  // Collect all sessions across all open projects for the active server.
  const allRecords = createMemo<RecallRecord[]>(() => {
    const conn = server.current
    if (!conn) return []

    const serverCtx = global.createServerCtx(conn)
    const projects = serverCtx.projects.list()
    const projectByID = new Map(
      projects.flatMap((project) => (project.id ? [[project.id, project] as const] : [])),
    )
    const now = Date.now()

    const seen = new Set<string>()
    const records: RecallRecord[] = []

    for (const project of projects) {
      const directories = [project.worktree, ...(project.sandboxes ?? [])]
      for (const directory of directories) {
        const [childStore] = sync.child(directory, { bootstrap: false })
        const sessions = sortedRootSessions(childStore, now)
        for (const session of sessions) {
          const key = `${pathKey(session.directory)}:${session.id}`
          if (seen.has(key)) continue
          seen.add(key)
          const proj = projectForSession(session, projects, projectByID)
          records.push({
            session,
            projectName: proj ? displayName(proj) : "",
            directory: session.directory,
          })
        }
      }
    }

    return records.sort(
      (a, b) =>
        (b.session.time.updated ?? b.session.time.created) -
        (a.session.time.updated ?? a.session.time.created),
    )
  })

  // Client-side filter by title + project name.
  const results = createMemo<RecallRecord[]>(() => {
    const q = query().trim().toLowerCase()
    if (!q) return allRecords()
    return allRecords().filter((record) => matchesQuery(record, q))
  })

  function openSession(record: RecallRecord) {
    navigate(`/${base64Encode(record.directory)}/session/${record.session.id}`)
    dialog.close()
  }

  return (
    <Dialog title="🔎 Recall — search past sessions">
      <div class="flex flex-col gap-3 px-1 pb-1">
        {/* Search input */}
        <div class="flex items-center gap-2 rounded-md border border-border-base bg-bg-base px-3 py-2 focus-within:border-border-focus focus-within:ring-1 focus-within:ring-border-focus">
          <svg
            class="size-4 shrink-0 text-text-weaker"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
              clip-rule="evenodd"
            />
          </svg>
          <input
            ref={inputRef}
            autofocus
            type="text"
            class="min-w-0 flex-1 border-0 bg-transparent text-sm text-text-strong outline-0 placeholder:text-text-weaker"
            placeholder="Search sessions by title or project…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <Show when={query()}>
            <button
              type="button"
              class="shrink-0 text-text-weaker hover:text-text-base"
              onClick={() => {
                setQuery("")
                inputRef?.focus()
              }}
              aria-label="Clear search"
            >
              <svg class="size-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </Show>
        </div>

        {/* Results list */}
        <div class="flex max-h-80 flex-col gap-px overflow-y-auto">
          <Show
            when={results().length > 0}
            fallback={
              <p class="px-2 py-4 text-center text-sm text-text-weaker">
                {query().trim() ? `No sessions matching "${query()}"` : "No sessions found"}
              </p>
            }
          >
            <For each={results()}>
              {(record) => {
                const title = createMemo(() => sessionTitle(record.session.title) || record.session.id)
                const key = () => recallKey(record)

                return (
                  <button
                    type="button"
                    data-key={key()}
                    class="flex w-full shrink-0 items-center gap-2 rounded-[6px] border-0 px-3 py-2.5 text-left transition-colors duration-[120ms] hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:outline-none"
                    onClick={() => openSession(record)}
                  >
                    {/* Title + project */}
                    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="truncate text-[13px] font-[530] leading-4 tracking-[-0.04px] text-text-strong">
                        {title()}
                      </span>
                      <div class="flex items-center gap-1.5">
                        <Show when={record.projectName}>
                          <span class="truncate text-[11px] font-[440] leading-4 text-text-weaker">
                            {record.projectName}
                          </span>
                          <span class="shrink-0 text-[11px] text-text-weaker opacity-50">·</span>
                        </Show>
                        <span class="shrink-0 text-[11px] font-[440] leading-4 text-text-weaker">
                          {formatUpdated(record.session)}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              }}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
