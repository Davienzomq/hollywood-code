import { Effect, Schema } from "effect"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import * as Tool from "./tool"
import DESCRIPTION from "./mcp-admin.txt"

export const Parameters = Schema.Struct({
  action: Schema.String.annotate({
    description: 'What to do: "list", "enable", "disable", or "add".',
  }),
  name: Schema.optional(
    Schema.String.annotate({
      description: "Server name. Required for enable / disable / add.",
    }),
  ),
  command: Schema.optional(
    Schema.String.annotate({
      description:
        'For action "add" of a LOCAL server: the shell command to run, e.g. "npx -y @playwright/mcp@latest".',
    }),
  ),
  url: Schema.optional(
    Schema.String.annotate({
      description: 'For action "add" of a REMOTE server: the server URL.',
    }),
  ),
})

type Params = Schema.Schema.Type<typeof Parameters>

export const McpAdminTool = Tool.define(
  "mcp",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const cfg = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const mk = (title: string, output: string, metadata: Record<string, unknown> = {}) => ({
            title,
            output,
            metadata,
          })
          const action = (params.action ?? "").trim().toLowerCase()
          const statuses = yield* mcp.status()
          const config = yield* cfg.get()
          const configured = config.mcp ?? {}

          const kindOf = (name: string) => {
            const entry = configured[name]
            return entry && typeof entry === "object" && "type" in entry ? (entry as { type: string }).type : "?"
          }
          const describe = (name: string) => `• ${name} — ${statuses[name]?.status ?? "disabled"} (${kindOf(name)})`

          if (action === "list" || action === "") {
            const names = Array.from(new Set([...Object.keys(configured), ...Object.keys(statuses)])).sort()
            const body = names.length ? names.map(describe).join("\n") : "No MCP servers configured."
            return mk(
              `${names.length} MCP server(s)`,
              body + "\n\nUse action=enable|disable with a name, or action=add with a command (local) or url (remote).",
              { count: names.length },
            )
          }

          if (action === "enable" || action === "disable") {
            const name = params.name?.trim()
            if (!name) return mk("Missing name", `action "${action}" requires a "name".`)
            if (!(name in configured) && !(name in statuses)) {
              const avail = Object.keys(configured).join(", ") || "(none)"
              return mk(`Unknown server: ${name}`, `No MCP server named "${name}". Configured servers: ${avail}`)
            }
            const outcome = yield* (action === "enable" ? mcp.connect(name) : mcp.disconnect(name)).pipe(
              Effect.as("ok" as const),
              Effect.catchTag("MCP.NotFoundError", () => Effect.succeed("notfound" as const)),
            )
            if (outcome === "notfound") return mk(`Unknown server: ${name}`, `No MCP server named "${name}".`)
            const after = (yield* mcp.status())[name]
            const st = after?.status ?? (action === "enable" ? "connected" : "disabled")
            const note = after && "error" in after ? `\n⚠️ ${after.error}` : ""
            return mk(
              `${name} → ${st}`,
              `${action === "enable" ? "Enabled" : "Disabled"} "${name}". Status: ${st}.${note}\nPersisted to the project config (survives restart).`,
              { name, status: st },
            )
          }

          if (action === "add") {
            const name = params.name?.trim()
            if (!name) return mk("Missing name", `action "add" requires a "name".`)
            if (!params.command && !params.url) {
              return mk(
                "Missing command/url",
                `action "add" requires either "command" (local server) or "url" (remote server).`,
              )
            }
            if (params.command && params.url) {
              return mk("Ambiguous", `Provide only one of "command" or "url", not both.`)
            }
            const entry: ConfigMCPV1.Info = params.url
              ? { type: "remote", url: params.url }
              : { type: "local", command: params.command!.split(/\s+/).filter(Boolean) }
            yield* mcp.addServer(name, entry)
            const after = (yield* mcp.status())[name]
            const st = after?.status ?? "connected"
            const note = after && "error" in after ? `\n⚠️ ${after.error}` : ""
            return mk(
              `Added ${name} → ${st}`,
              `Added MCP server "${name}" to the project config and enabled it. Status: ${st}.${note}`,
              { name, status: st },
            )
          }

          return mk(`Unknown action: ${action}`, `Unknown action "${action}". Valid actions: list, enable, disable, add.`)
        }).pipe(Effect.orDie),
    }
  }),
)
