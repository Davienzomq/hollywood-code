/**
 * Integration tests for the Hollywood Code router wired through the real
 * SessionPrompt path.  Uses the same fake-LLM-server harness as
 * test/session/prompt.test.ts so no product code is touched.
 *
 * Each test manages HOLLYWOOD_ROUTER explicitly (save/restore) because
 * isEnabled() is read per call.
 */

import { NodeFileSystem } from "@effect/platform-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { Database } from "@opencode-ai/core/database/database"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

// ---------------------------------------------------------------------------
// Minimal stubs — mirror the stubs in prompt.test.ts
// ---------------------------------------------------------------------------

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    addServer: () => Effect.void,
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function makePrompt() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    FSUtil.defaultLayer,
    BackgroundJob.defaultLayer,
    status,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp() {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt())
}

const it = testEffect(makeHttp())

// ---------------------------------------------------------------------------
// Provider config helpers
//
// We use provider id "anthropic" so the router's TIER_CANDIDATES["anthropic"]
// table kicks in.  The three models cover low / mid / high tiers.  The fake
// LLM server's baseURL is injected at runtime.
// ---------------------------------------------------------------------------

const MODEL_LOW = "claude-haiku-4-5"   // anthropic low[0]
const MODEL_MID = "claude-sonnet-4-6"  // anthropic mid[0]
const MODEL_HIGH = "claude-fable-5"    // anthropic high[0]
const MODEL_DEFAULT = MODEL_LOW        // first model alphabetically / by key order

function makeModel(id: string) {
  return {
    id,
    name: id,
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    release_date: "2025-01-01",
    limit: { context: 100000, output: 10000 },
    cost: { input: 0, output: 0 },
    options: {},
  }
}

function anthropicCfg(url: string) {
  return {
    provider: {
      anthropic: {
        name: "Anthropic",
        id: "anthropic",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          [MODEL_LOW]: makeModel(MODEL_LOW),
          [MODEL_MID]: makeModel(MODEL_MID),
          [MODEL_HIGH]: makeModel(MODEL_HIGH),
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

/** Config with only an unknown provider — none of the router candidates match */
function unknownProviderCfg(url: string) {
  return {
    provider: {
      "mystery-ai": {
        name: "Mystery AI",
        id: "mystery-ai",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "mystery-model": makeModel("mystery-model"),
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

/** Write opencode.json into the test instance directory */
const writeConfig = Effect.fn("routing.writeConfig")(function* (
  dir: string,
  config: Record<string, unknown>,
) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

/** Obtain the LLM server URL and write the config in one step */
const useConfig = Effect.fn("routing.useConfig")(function* (
  buildCfg: (url: string) => Record<string, unknown>,
) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, buildCfg(llm.url))
  return { dir, llm }
})

// ---------------------------------------------------------------------------
// Helpers for env-var save/restore
// ---------------------------------------------------------------------------

function routerOn() {
  delete process.env["HOLLYWOOD_ROUTER"]
}

function routerOff() {
  process.env["HOLLYWOOD_ROUTER"] = "off"
}

function saveRouter(): string | undefined {
  return process.env["HOLLYWOOD_ROUTER"]
}

function restoreRouter(prev: string | undefined) {
  if (prev === undefined) delete process.env["HOLLYWOOD_ROUTER"]
  else process.env["HOLLYWOOD_ROUTER"] = prev
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.instance(
  "low-tier prompt routes to the double (haiku)",
  () =>
    Effect.gen(function* () {
      const prev = saveRouter()
      routerOn()
      try {
        yield* useConfig(anthropicCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const session = yield* sessions.create({ title: "routing-low" })
        // "oi" matches LOW_COMPLEXITY regex → tier "low"
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "oi" }],
        })

        expect(msg.info.role).toBe("user")
        if (msg.info.role !== "user") return
        expect(msg.info.model.providerID).toBe(ProviderV2.ID.make("anthropic"))
        expect(msg.info.model.modelID).toBe(ModelV2.ID.make(MODEL_LOW))
      } finally {
        restoreRouter(prev)
      }
    }),
)

it.instance(
  "high-tier prompt routes to the star (fable-5), even after a prior low-tier message",
  () =>
    Effect.gen(function* () {
      const prev = saveRouter()
      routerOn()
      try {
        const { llm } = yield* useConfig(anthropicCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const session = yield* sessions.create({ title: "routing-high" })

        // First turn: low-tier — should route to haiku
        const lowMsg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "oi" }],
        })
        expect(lowMsg.info.role).toBe("user")
        if (lowMsg.info.role === "user") {
          expect(lowMsg.info.model.modelID).toBe(ModelV2.ID.make(MODEL_LOW))
        }

        // The router ignores previous automatic model state: high turn must go to star.
        // Queue a reply so the loop after the first prompt doesn't hang if it runs.
        yield* llm.text("ok")

        // High-tier prompt (matches HIGH_COMPLEXITY and QUALITY_WORDS, long enough)
        const highText = (
          "Design the architecture for a payment processing system and then implement the API schema, " +
          "also plan the database migrations and integrate the authentication layer for production security. "
        ).repeat(6)

        const highMsg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: highText }],
        })
        expect(highMsg.info.role).toBe("user")
        if (highMsg.info.role !== "user") return
        expect(highMsg.info.model.providerID).toBe(ProviderV2.ID.make("anthropic"))
        expect(highMsg.info.model.modelID).toBe(ModelV2.ID.make(MODEL_HIGH))
      } finally {
        restoreRouter(prev)
      }
    }),
)

it.instance(
  "explicit model in prompt.prompt bypasses the router entirely",
  () =>
    Effect.gen(function* () {
      const prev = saveRouter()
      routerOn()
      try {
        yield* useConfig(anthropicCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const session = yield* sessions.create({ title: "routing-manual" })

        // Explicit model: mid (sonnet) — even though "oi" would score low
        const explicitModel = {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make(MODEL_MID),
        }

        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          model: explicitModel,
          parts: [{ type: "text", text: "oi" }],
        })

        expect(msg.info.role).toBe("user")
        if (msg.info.role !== "user") return
        expect(msg.info.model.providerID).toBe(ProviderV2.ID.make("anthropic"))
        // Must be sonnet (the explicit pick), not haiku (the router's low choice)
        expect(msg.info.model.modelID).toBe(ModelV2.ID.make(MODEL_MID))
      } finally {
        restoreRouter(prev)
      }
    }),
)

it.instance(
  "fallback safety: unknown provider has no router candidates → uses configured default",
  () =>
    Effect.gen(function* () {
      const prev = saveRouter()
      routerOn()
      try {
        yield* useConfig(unknownProviderCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const session = yield* sessions.create({ title: "routing-fallback" })
        // Any text: the router finds no candidates for "mystery-ai" and falls
        // back to base.value which is mystery-ai / mystery-model
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "oi" }],
        })

        expect(msg.info.role).toBe("user")
        if (msg.info.role !== "user") return
        // Still succeeds — falls back to the default configured model
        expect(msg.info.model.providerID).toBe(ProviderV2.ID.make("mystery-ai"))
        expect(msg.info.model.modelID).toBe(ModelV2.ID.make("mystery-model"))
      } finally {
        restoreRouter(prev)
      }
    }),
)
