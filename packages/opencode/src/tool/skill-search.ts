import { pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill-search.txt"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Keywords describing the task; matched against skill names and descriptions.",
  }),
})

const MAX_RESULTS = 20

export const SkillSearchTool = Tool.define(
  "skill_search",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const agents = yield* Agent.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          const list = yield* skill.available(agent)

          const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean)
          const scored = list
            .map((s) => {
              const hay = `${s.name} ${s.description ?? ""}`.toLowerCase()
              let score = 0
              for (const term of terms) {
                if (s.name.toLowerCase().includes(term)) score += 2 // name hits weigh more
                else if (hay.includes(term)) score += 1
              }
              return { s, score }
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_RESULTS)

          if (scored.length === 0) {
            return {
              title: `No skills match "${params.query}"`,
              output:
                `No skills matched "${params.query}". ${list.length} skills are available — try broader or different keywords.`,
              metadata: { count: 0, total: list.length },
            }
          }

          const output = [
            `<matching_skills query="${params.query}">`,
            ...scored.flatMap(({ s }) => [
              "  <skill>",
              `    <name>${s.name}</name>`,
              `    <description>${s.description ?? ""}</description>`,
              `    <location>${pathToFileURL(s.location).href}</location>`,
              "  </skill>",
            ]),
            "</matching_skills>",
            "",
            "Load a skill with the `skill` tool using its exact name.",
          ].join("\n")

          return {
            title: `Found ${scored.length} skill(s) for "${params.query}"`,
            output,
            metadata: { count: scored.length, total: list.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
