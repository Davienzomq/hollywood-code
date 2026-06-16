#!/usr/bin/env bun
/**
 * Hollycode Home Assistant MCP server (stdio).
 *
 * Mirrors Hermes' `ha_*` tool set: a thin wrapper over the Home Assistant
 * REST API (https://developers.home-assistant.io/docs/api/rest/) exposing
 * entity listing/lookup, service discovery, and service calls.
 *
 * Backend config: HA_URL (e.g. http://homeassistant.local:8123) and HA_TOKEN
 * (a Long-Lived Access Token from the user's HA profile) in the environment.
 * Every request sends Authorization: "Bearer <HA_TOKEN>" and
 * Content-Type: application/json against `${HA_URL}/api/...`.
 *
 * Protocol: this speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * by hand so it needs zero extra dependencies — opencode connects to it like
 * any other local MCP server (see packages/opencode/src/mcp/index.ts).
 */

// --- Home Assistant REST backend ---------------------------------------------
const NOT_CONFIGURED_MESSAGE =
  "Home Assistant is not configured. Set HA_URL and HA_TOKEN (a Long-Lived Access Token from your HA profile)."

interface HaConfig {
  url: string
  token: string
}

function resolveConfig(): HaConfig | null {
  const url = (process.env.HA_URL || "").trim()
  const token = (process.env.HA_TOKEN || "").trim()
  if (!url || !token) return null
  return { url: url.replace(/\/+$/, ""), token }
}

type HaResult = { ok: true; data: unknown } | { ok: false; error: string }

async function haRequest(config: HaConfig, path: string, init?: { method?: string; body?: unknown }): Promise<HaResult> {
  try {
    const res = await fetch(`${config.url}/api${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { ok: false, error: `Home Assistant ${res.status}: ${text.slice(0, 300)}` }
    }
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// --- tool implementations -----------------------------------------------------
interface HaState {
  entity_id: string
  state: string
  attributes?: Record<string, unknown>
  last_changed?: string
  last_updated?: string
}

async function haListEntities(config: HaConfig, domain?: string): Promise<HaResult> {
  const result = await haRequest(config, "/states")
  if (!result.ok) return result
  const states = (result.data as HaState[]) || []
  const prefix = domain && domain.trim() ? `${domain.trim()}.` : null
  const filtered = prefix ? states.filter((s) => s.entity_id.startsWith(prefix)) : states
  const compact = filtered.map((s) => ({ entity_id: s.entity_id, state: s.state }))
  return { ok: true, data: compact }
}

async function haGetState(config: HaConfig, entityId: string): Promise<HaResult> {
  if (!entityId || !entityId.trim()) return { ok: false, error: "entity_id is required" }
  const result = await haRequest(config, `/states/${encodeURIComponent(entityId.trim())}`)
  if (!result.ok) return result
  const s = result.data as HaState
  return {
    ok: true,
    data: {
      entity_id: s.entity_id,
      state: s.state,
      attributes: s.attributes ?? {},
      last_changed: s.last_changed,
      last_updated: s.last_updated,
    },
  }
}

interface HaServiceDomain {
  domain: string
  services: Record<string, unknown>
}

async function haListServices(config: HaConfig): Promise<HaResult> {
  const result = await haRequest(config, "/services")
  if (!result.ok) return result
  const domains = (result.data as HaServiceDomain[]) || []
  const compact = domains.map((d) => ({ domain: d.domain, services: Object.keys(d.services || {}) }))
  return { ok: true, data: compact }
}

async function haCallService(
  config: HaConfig,
  domain: string,
  service: string,
  entityId?: string,
  data?: Record<string, unknown>,
): Promise<HaResult> {
  if (!domain || !domain.trim()) return { ok: false, error: "domain is required" }
  if (!service || !service.trim()) return { ok: false, error: "service is required" }
  const body: Record<string, unknown> = { ...(data ?? {}) }
  if (entityId && entityId.trim()) body.entity_id = entityId.trim()
  return haRequest(config, `/services/${domain.trim()}/${service.trim()}`, { method: "POST", body })
}

// --- MCP stdio JSON-RPC plumbing --------------------------------------------
const PROTOCOL_VERSION = "2024-11-05"
const TOOLS = [
  {
    name: "ha_list_entities",
    description: "List Home Assistant entities (entity_id + state). Optionally filter by domain prefix, e.g. 'light'.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain prefix to filter by, e.g. 'light', 'switch', 'sensor'." },
      },
    },
  },
  {
    name: "ha_get_state",
    description: "Get the current state and key attributes of a single Home Assistant entity.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Full entity id, e.g. 'light.living_room'." },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "ha_list_services",
    description: "List the available Home Assistant service domains and their service names.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ha_call_service",
    description: "Call a Home Assistant service, e.g. domain='light' service='turn_on' entity_id='light.living_room'.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Service domain, e.g. 'light', 'switch', 'climate'." },
        service: { type: "string", description: "Service name, e.g. 'turn_on', 'turn_off', 'toggle'." },
        entity_id: { type: "string", description: "Target entity id, e.g. 'light.living_room' (optional)." },
        data: { type: "object", description: "Additional service data fields (optional)." },
      },
      required: ["domain", "service"],
    },
  },
]

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function reply(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

function textResult(data: unknown, isError?: boolean) {
  const text = typeof data === "string" ? data : JSON.stringify(data)
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] }
}

async function callTool(name: string, args: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const config = resolveConfig()
  if (!config) return textResult(NOT_CONFIGURED_MESSAGE, true)

  switch (name) {
    case "ha_list_entities": {
      const result = await haListEntities(config, args?.domain ? String(args.domain) : undefined)
      return result.ok ? textResult(result.data) : textResult(result.error, true)
    }
    case "ha_get_state": {
      const result = await haGetState(config, String(args?.entity_id ?? ""))
      return result.ok ? textResult(result.data) : textResult(result.error, true)
    }
    case "ha_list_services": {
      const result = await haListServices(config)
      return result.ok ? textResult(result.data) : textResult(result.error, true)
    }
    case "ha_call_service": {
      const result = await haCallService(
        config,
        String(args?.domain ?? ""),
        String(args?.service ?? ""),
        args?.entity_id ? String(args.entity_id) : undefined,
        args?.data && typeof args.data === "object" ? (args.data as Record<string, unknown>) : undefined,
      )
      return result.ok ? textResult(result.data) : textResult(result.error, true)
    }
    default:
      return textResult(`Unknown tool: ${name}`, true)
  }
}

async function handle(msg: any) {
  const { id, method, params } = msg
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "hollycode-homeassistant", version: "0.1.0" },
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
      const out = await callTool(toolName, params?.arguments ?? {})
      reply(id, out)
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
