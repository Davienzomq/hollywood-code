#!/usr/bin/env bun
/**
 * Hollycode Spotify MCP server (stdio).
 *
 * Backend: the Spotify Web API (https://developer.spotify.com/documentation/web-api).
 * Search, playback control (play/pause/next/previous), now-playing, and playlists.
 *
 * Backend auth: SPOTIFY_TOKEN (a user OAuth access token) in the environment.
 * Optionally SPOTIFY_REFRESH_TOKEN + SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET —
 * if all three are present, on a 401 we refresh once via
 * POST https://accounts.spotify.com/api/token (grant_type=refresh_token) using
 * HTTP Basic auth (base64 of clientId:clientSecret) and retry the request with
 * the fresh access token.
 *
 * Protocol: this speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * by hand so it needs zero extra dependencies — opencode connects to it like
 * any other local MCP server (see packages/opencode/src/mcp/index.ts).
 */

// --- Spotify backend ---------------------------------------------------------
const API_BASE = "https://api.spotify.com/v1"
const ACCOUNTS_TOKEN_URL = "https://accounts.spotify.com/api/token"
const NOT_CONFIGURED_ERROR =
  'Spotify is not configured. Set SPOTIFY_TOKEN (an OAuth access token) — see https://developer.spotify.com/documentation/web-api.'

// In-memory cache of a refreshed access token, so repeated calls in the same
// process don't have to refresh every time.
let cachedAccessToken: string | null = null

function hasRefreshCreds(): boolean {
  return Boolean(
    (process.env.SPOTIFY_REFRESH_TOKEN || "").trim() &&
      (process.env.SPOTIFY_CLIENT_ID || "").trim() &&
      (process.env.SPOTIFY_CLIENT_SECRET || "").trim(),
  )
}

function currentToken(): string {
  return cachedAccessToken || (process.env.SPOTIFY_TOKEN || "").trim()
}

async function refreshAccessToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const refreshToken = (process.env.SPOTIFY_REFRESH_TOKEN || "").trim()
  const clientId = (process.env.SPOTIFY_CLIENT_ID || "").trim()
  const clientSecret = (process.env.SPOTIFY_CLIENT_SECRET || "").trim()
  if (!refreshToken || !clientId || !clientSecret) {
    return { ok: false, error: "Refresh credentials are not fully configured." }
  }
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
    const res = await fetch(ACCOUNTS_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { ok: false, error: `Token refresh failed ${res.status}: ${text.slice(0, 300)}` }
    }
    const data = (await res.json()) as { access_token?: string }
    if (!data.access_token) return { ok: false, error: "Token refresh response had no access_token" }
    cachedAccessToken = data.access_token
    return { ok: true, token: data.access_token }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

interface SpotifyResult {
  ok: boolean
  status: number
  body: unknown
  bodyText: string
}

/**
 * Performs a Spotify Web API request with the current token. On a 401, if
 * refresh credentials are present, refreshes once and retries the request.
 */
async function spotifyFetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<SpotifyResult> {
  const doFetch = async (token: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    let body: string | undefined
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(init.body)
    }
    return fetch(`${API_BASE}${path}`, { method: init.method || "GET", headers, body })
  }

  let token = currentToken()
  let res = await doFetch(token)

  if (res.status === 401 && hasRefreshCreds()) {
    const refreshed = await refreshAccessToken()
    if (refreshed.ok) {
      token = refreshed.token
      res = await doFetch(token)
    }
  }

  if (res.status === 204) {
    return { ok: true, status: 204, body: null, bodyText: "" }
  }

  const text = await res.text().catch(() => "")
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  return { ok: res.ok, status: res.status, body: parsed, bodyText: text }
}

function formatHttpError(result: SpotifyResult): string {
  if (result.status === 204) {
    return "Spotify returned 204 No Content (no active device — open Spotify on a device and try again)."
  }
  const truncated = result.bodyText.slice(0, 300)
  return `Spotify API ${result.status}: ${truncated || "(empty body)"}`
}

type ToolOutcome = { ok: true; text: string } | { ok: false; error: string }

function notConfigured(): ToolOutcome {
  return { ok: false, error: NOT_CONFIGURED_ERROR }
}

function isConfigured(): boolean {
  return Boolean((process.env.SPOTIFY_TOKEN || "").trim() || hasRefreshCreds())
}

async function spotifySearch(query: string, type: string): Promise<ToolOutcome> {
  if (!isConfigured()) return notConfigured()
  if (!query || !query.trim()) return { ok: false, error: "query is required" }
  const searchType = (type || "track").trim() || "track"
  const params = new URLSearchParams({ q: query.trim(), type: searchType, limit: "10" })
  try {
    const result = await spotifyFetch(`/search?${params.toString()}`)
    if (!result.ok) return { ok: false, error: formatHttpError(result) }
    const body = result.body as Record<string, any>
    const key = `${searchType}s`
    const items: any[] = body?.[key]?.items || []
    if (!items.length) return { ok: true, text: `No ${searchType} results for "${query}".` }
    const lines = items.map((item, i) => {
      const name = item?.name ?? "(unknown)"
      const artist =
        item?.artists?.map((a: any) => a?.name).filter(Boolean).join(", ") ||
        item?.display_name ||
        item?.owner?.display_name ||
        ""
      const uri = item?.uri ?? ""
      return `${i + 1}. ${name}${artist ? ` — ${artist}` : ""} (${uri})`
    })
    return { ok: true, text: `Top ${searchType} results for "${query}":\n${lines.join("\n")}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function spotifyPlay(uri: string | undefined): Promise<ToolOutcome> {
  if (!isConfigured()) return notConfigured()
  try {
    const body = uri && uri.trim() ? { uris: [uri.trim()] } : undefined
    const result = await spotifyFetch("/me/player/play", { method: "PUT", body })
    if (!result.ok) return { ok: false, error: formatHttpError(result) }
    return { ok: true, text: uri ? `Playing ${uri}.` : "Resumed playback." }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function spotifyPause(): Promise<ToolOutcome> {
  if (!isConfigured()) return notConfigured()
  try {
    const result = await spotifyFetch("/me/player/pause", { method: "PUT" })
    if (!result.ok) return { ok: false, error: formatHttpError(result) }
    return { ok: true, text: "Playback paused." }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function spotifyNext(): Promise<ToolOutcome> {
  if (!isConfigured()) return notConfigured()
  try {
    const result = await spotifyFetch("/me/player/next", { method: "POST" })
    if (!result.ok) return { ok: false, error: formatHttpError(result) }
    return { ok: true, text: "Skipped to next track." }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function spotifyPrevious(): Promise<ToolOutcome> {
  if (!isConfigured()) return notConfigured()
  try {
    const result = await spotifyFetch("/me/player/previous", { method: "POST" })
    if (!result.ok) return { ok: false, error: formatHttpError(result) }
    return { ok: true, text: "Skipped to previous track." }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function spotifyCurrent(): Promise<ToolOutcome> {
  if (!isConfigured()) return notConfigured()
  try {
    const result = await spotifyFetch("/me/player/currently-playing")
    if (result.status === 204) return { ok: true, text: "Nothing is currently playing." }
    if (!result.ok) return { ok: false, error: formatHttpError(result) }
    const body = result.body as Record<string, any>
    const item = body?.item
    if (!item) return { ok: true, text: "Nothing is currently playing." }
    const name = item?.name ?? "(unknown)"
    const artist = item?.artists?.map((a: any) => a?.name).filter(Boolean).join(", ") || "(unknown artist)"
    const isPlaying = Boolean(body?.is_playing)
    return { ok: true, text: `${name} — ${artist} (${isPlaying ? "playing" : "paused"})` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function spotifyPlaylists(): Promise<ToolOutcome> {
  if (!isConfigured()) return notConfigured()
  try {
    const result = await spotifyFetch("/me/playlists?limit=50")
    if (!result.ok) return { ok: false, error: formatHttpError(result) }
    const body = result.body as Record<string, any>
    const items: any[] = body?.items || []
    if (!items.length) return { ok: true, text: "No playlists found." }
    const lines = items.map((p, i) => `${i + 1}. ${p?.name ?? "(unnamed)"} (${p?.id ?? "unknown id"})`)
    return { ok: true, text: `Playlists:\n${lines.join("\n")}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// --- MCP stdio JSON-RPC plumbing --------------------------------------------
const PROTOCOL_VERSION = "2024-11-05"

const TOOLS = [
  {
    name: "spotify_search",
    description: "Search Spotify and return the top results (name, artist, and URI).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        type: {
          type: "string",
          description: 'Item type to search for, e.g. "track", "artist", "album", or "playlist".',
          default: "track",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "spotify_play",
    description: "Start or resume playback on the active device. Pass a Spotify URI to play a specific track, or omit it to resume.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "A Spotify track URI (e.g. spotify:track:...) to play. Omit to resume playback." },
      },
    },
  },
  {
    name: "spotify_pause",
    description: "Pause playback on the active device.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spotify_next",
    description: "Skip to the next track.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spotify_previous",
    description: "Skip to the previous track.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spotify_current",
    description: "Get the currently playing track (name, artist, and play state).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spotify_playlists",
    description: "List the current user's playlists (name and id).",
    inputSchema: { type: "object", properties: {} },
  },
]

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function reply(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

function toolResult(out: ToolOutcome) {
  if (out.ok) return { content: [{ type: "text", text: out.text }] }
  return { content: [{ type: "text", text: out.error }], isError: true }
}

async function callTool(name: string, args: Record<string, unknown> | undefined): Promise<ToolOutcome> {
  switch (name) {
    case "spotify_search":
      return spotifySearch(String(args?.query ?? ""), String(args?.type ?? "track"))
    case "spotify_play":
      return spotifyPlay(args?.uri !== undefined ? String(args.uri) : undefined)
    case "spotify_pause":
      return spotifyPause()
    case "spotify_next":
      return spotifyNext()
    case "spotify_previous":
      return spotifyPrevious()
    case "spotify_current":
      return spotifyCurrent()
    case "spotify_playlists":
      return spotifyPlaylists()
    default:
      return { ok: false, error: `Unknown tool: ${name}` }
  }
}

async function handle(msg: any) {
  const { id, method, params } = msg
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "hollycode-spotify", version: "0.1.0" },
      })
      return
    case "notifications/initialized":
    case "initialized":
      return // notification, no response
    case "ping":
      reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: TOOLS })
      return
    case "tools/call": {
      const toolName = params?.name
      if (!TOOLS.some((t) => t.name === toolName)) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } })
        return
      }
      const out = await callTool(toolName, params?.arguments)
      reply(id, toolResult(out))
      return
    }
    default:
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let nl: number
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg).catch((e) => {
      if (msg?.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } })
    })
  }
})
process.stdin.on("end", () => process.exit(0))
