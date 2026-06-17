import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import * as Selection from "./util/selection"
import { createCliRenderer, MouseButton, type CliRenderer } from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  on,
} from "solid-js"
import { TuiPathsProvider, TuiStartupProvider, TuiTerminalEnvironmentProvider, useTuiStartup } from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogProvider as DialogProviderList } from "./component/dialog-provider"
import { ErrorComponent } from "./component/error-component"
import { PluginRouteMissing } from "./component/plugin-route-missing"
import { ProjectProvider, useProject } from "./context/project"
import { EditorContextProvider } from "./context/editor"
import { useEvent } from "./context/event"
import { SDKProvider, useSDK } from "./context/sdk"
import { StartupLoading } from "./component/startup-loading"
import { SyncProvider, useSync } from "./context/sync"
import { SyncProviderV2 } from "./context/sync-v2"
import { LocalProvider, useLocal } from "./context/local"
import { DialogModel } from "./component/dialog-model"
import { useConnected } from "./component/use-connected"
import { DialogMcp } from "./component/dialog-mcp"
import { DialogStatus } from "./component/dialog-status"
import { DialogThemeList } from "./component/dialog-theme-list"
import { DialogOnboarding, onboardingDone } from "./component/dialog-onboarding"
import { DialogHelp } from "./ui/dialog-help"
import { DialogAgent } from "./component/dialog-agent"
import { DialogSessionList } from "./component/dialog-session-list"
import { DialogWorkspaceList } from "./component/dialog-workspace-list"
import { DialogConsoleOrg } from "./component/dialog-console-org"
import { ThemeProvider, useTheme } from "./context/theme"
import { Home } from "./routes/home"
import { Session } from "./routes/session"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { DialogConfirm } from "./ui/dialog-confirm"
import { ToastProvider, useToast } from "./ui/toast"
import { isDefaultTitle } from "./util/session"
import { KVProvider, useKV } from "./context/kv"
import * as Model from "./util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig, type TuiConfig } from "./config"
import { createTuiApiAdapters } from "./plugin/adapters"
import { createTuiApi } from "./plugin/api"
import { createPluginRuntime, PluginRuntimeProvider, usePluginRuntime, type TuiPluginHost } from "./plugin/runtime"
import { CommandPaletteDialog } from "./component/command-palette"
import {
  COMMAND_PALETTE_COMMAND,
  OPENCODE_BASE_MODE,
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useBindings,
  useOpencodeKeymap,
} from "./keymap"

import type { EventSource } from "./context/sdk"
import { DialogVariant } from "./component/dialog-variant"
import { createTuiAttention } from "./attention"
import * as TuiAudio from "./audio"
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./terminal-win32"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync } from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { DialogPrompt } from "./ui/dialog-prompt"

const appGlobalBindingCommands = [
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show",
  "model.list",
  "model.cycle_recent",
  "model.cycle_recent_reverse",
  "model.cycle_favorite",
  "model.cycle_favorite_reverse",
  "agent.list",
  "mcp.list",
  "agent.cycle",
  "agent.cycle.reverse",
  "variant.cycle",
  "variant.list",
  "provider.connect",
  "console.org.switch",
  "opencode.status",
  "theme.switch",
  "theme.switch_mode",
  "theme.mode.lock",
  "help.show",
  "docs.open",
  "workspace.list",
  "app.debug",
  "app.console",
  "app.heap_snapshot",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
] as const

export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  pluginHost: TuiPluginHost
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

function isVersionGreater(left: string, right: string) {
  const parse = (value: string) => {
    const [core, prerelease] = value.replace(/^v/, "").split("-", 2)
    return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), prerelease }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference) return difference > 0
  }
  if (a.prerelease === b.prerelease) return false
  if (!a.prerelease) return true
  if (!b.prerelease) return false
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true }) > 0
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const global = yield* Global.Service
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          createCliRenderer({
            externalOutputMode: "passthrough",
            targetFps: 60,
            gatherStats: false,
            exitOnCtrlC: false,
            useKittyKeyboard: {},
            autoFocus: false,
            openConsoleOnError: false,
            useMouse: !Flag.OPENCODE_DISABLE_MOUSE && input.config.mouse,
            consoleOptions: {
              keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
            },
          }),
        ),
        (renderer) =>
          Effect.sync(() => {
            destroyRenderer(renderer)
          }),
      )
      win32DisableProcessedInput()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerOpencodeKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await input.pluginHost.dispose()
          } catch (error) {
            console.error("Failed to dispose TUI plugins", error)
          }
        }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(TuiAudio.dispose))
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))
      const pluginRuntime = createPluginRuntime()

      yield* Effect.tryPromise(async () => {
        // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                destroyRenderer(renderer)
              }}
            >
              <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <TuiPathsProvider
                    value={{
                      cwd: process.cwd(),
                      home: global.home,
                      state: global.state,
                      worktree: global.data + "/worktree",
                    }}
                  >
                    <TuiTerminalEnvironmentProvider
                      value={{
                        platform: process.platform,
                        multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                        displayServer: process.env.WAYLAND_DISPLAY
                          ? "wayland"
                          : process.env.DISPLAY
                            ? "x11"
                            : undefined,
                      }}
                    >
                      <TuiStartupProvider
                        value={{
                          initialRoute: process.env.OPENCODE_ROUTE ? JSON.parse(process.env.OPENCODE_ROUTE) : undefined,
                          skipInitialLoading: Boolean(process.env.OPENCODE_FAST_BOOT),
                        }}
                      >
                        <ClipboardProvider>
                          <OpencodeKeymapProvider keymap={keymap}>
                            <ArgsProvider {...input.args}>
                              <KVProvider>
                                <ToastProvider>
                                  <RouteProvider
                                    initialRoute={
                                      input.args.continue
                                        ? {
                                            type: "session",
                                            sessionID: "dummy",
                                          }
                                        : undefined
                                    }
                                  >
                                    <TuiConfigProvider config={input.config}>
                                      <PluginRuntimeProvider value={pluginRuntime}>
                                        <SDKProvider
                                          url={input.url}
                                          directory={input.directory}
                                          fetch={input.fetch}
                                          headers={input.headers}
                                          events={input.events}
                                        >
                                          <ProjectProvider>
                                            <SyncProvider>
                                              <SyncProviderV2>
                                                <ThemeProvider mode={mode}>
                                                  <LocalProvider>
                                                    <PromptStashProvider>
                                                      <DialogProvider>
                                                        <FrecencyProvider>
                                                          <PromptHistoryProvider>
                                                            <PromptRefProvider>
                                                              <EditorContextProvider>
                                                                <App
                                                                  onSnapshot={input.onSnapshot}
                                                                  pluginHost={input.pluginHost}
                                                                />
                                                              </EditorContextProvider>
                                                            </PromptRefProvider>
                                                          </PromptHistoryProvider>
                                                        </FrecencyProvider>
                                                      </DialogProvider>
                                                    </PromptStashProvider>
                                                  </LocalProvider>
                                                </ThemeProvider>
                                              </SyncProviderV2>
                                            </SyncProvider>
                                          </ProjectProvider>
                                        </SDKProvider>
                                      </PluginRuntimeProvider>
                                    </TuiConfigProvider>
                                  </RouteProvider>
                                </ToastProvider>
                              </KVProvider>
                            </ArgsProvider>
                          </OpencodeKeymapProvider>
                        </ClipboardProvider>
                      </TuiStartupProvider>
                    </TuiTerminalEnvironmentProvider>
                  </TuiPathsProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
      })
      yield* Deferred.await(shutdown)
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (exit.reason !== undefined)
      process.stderr.write((cliErrorMessage(exit.reason) ?? errorFormat(exit.reason)) + "\n")
    if (exit.epilogue) process.stdout.write(exit.epilogue + "\n")
  })
})

// ── /loop module-level state (survives dialog close; cleared on stop) ──
let hollycodeLoopTimer: ReturnType<typeof setInterval> | undefined
let hollycodeLoopSeconds = 60
let hollycodeLoopPrompt = ""

function App(props: { onSnapshot?: () => Promise<string[]>; pluginHost: TuiPluginHost }) {
  const startup = useTuiStartup()
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useOpencodeKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode, locked, lock, unlock } = themeState
  const sync = useSync()
  const project = useProject()
  const exit = useExit()
  const promptRef = usePromptRef()
  const pluginRuntime = usePluginRuntime()
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
  const clipboard = useClipboard()

  const api = createTuiApi(
    createTuiApiAdapters({
      version: InstallationVersion,
      tuiConfig,
      dialog,
      keymap,
      kv,
      route,
      routes: pluginRuntime.routes,
      event,
      sdk,
      sync,
      theme: themeState,
      toast,
      renderer,
      attention,
      Slot: pluginRuntime.Slot,
    }),
  )
  const [ready, setReady] = createSignal(false)
  props.pluginHost
    .start({
      api,
      config: tuiConfig,
      runtime: pluginRuntime,
      dispose: () => attention.dispose(),
    })
    .catch((error) => {
      console.error("Failed to load TUI plugins", error)
    })
    .finally(() => {
      setReady(true)
    })

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
    if (hollycodeLoopTimer !== undefined) {
      clearInterval(hollycodeLoopTimer)
      hollycodeLoopTimer = undefined
    }
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.OPENCODE_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("Hollycode")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("Hollycode")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`OC | ${title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`OC | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Model.parse(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  // First-run onboarding: open the guided setup once, on a fresh install.
  onMount(() => {
    if (onboardingDone()) return
    setTimeout(() => {
      if (dialog.stack.length === 0) dialog.replace(() => <DialogOnboarding />)
    }, 400)
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  const connected = useConnected()
  const currentWorktreeWorkspace = createMemo(() => {
    const workspaceID = project.workspace.current()
    if (!workspaceID) return
    const workspace = project.workspace.get(workspaceID)
    if (workspace?.type !== "worktree" || !workspace.directory) return
    return workspace
  })
  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: "Show command palette",
        category: "System",
        hidden: true,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "session.list",
        title: "Switch session",
        category: "Session",
        suggested: sync.data.session.length > 0,
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run: () => {
          dialog.replace(() => <DialogSessionList />)
        },
      },
      {
        name: "session.new",
        title: "New session",
        suggested: route.data.type === "session",
        category: "Session",
        slashName: "new",
        slashAliases: ["clear"],
        run: () => {
          route.navigate({
            type: "home",
          })
          dialog.clear()
        },
      },
      {
        name: "workspace.copy_path",
        title: "Copy worktree path",
        category: "Workspace",
        enabled: () => currentWorktreeWorkspace() !== undefined,
        run: async () => {
          const workspace = currentWorktreeWorkspace()
          if (!workspace?.directory) return
          await clipboard
            .write?.(workspace.directory)
            .then(() => toast.show({ message: "Copied worktree path", variant: "info" }))
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "workspace.list",
        title: "Manage workspaces",
        category: "Workspace",
        hidden: !Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
        slashName: "workspaces",
        run: () => {
          dialog.replace(() => <DialogWorkspaceList />)
        },
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `session.quick_switch.${i + 1}`,
        title: `Switch to session in quick slot ${i + 1}`,
        category: "Session",
        hidden: true,
        run: () => {
          local.session.quickSwitch(i + 1)
        },
      })),
      {
        name: "model.list",
        title: "Switch model",
        suggested: true,
        category: "Agent",
        slashName: "models",
        // Bias /mo toward /models over /move without changing global fuzzy scoring.
        slashAliases: ["mo"],
        run: () => {
          dialog.replace(() => <DialogModel />)
        },
      },
      {
        name: "model.cycle_recent",
        title: "Model cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycle(1)
        },
      },
      {
        name: "model.cycle_recent_reverse",
        title: "Model cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycle(-1)
        },
      },
      {
        name: "model.cycle_favorite",
        title: "Favorite cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(1)
        },
      },
      {
        name: "model.cycle_favorite_reverse",
        title: "Favorite cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(-1)
        },
      },
      {
        name: "agent.list",
        title: "Switch agent",
        category: "Agent",
        slashName: "agents",
        run: () => {
          dialog.replace(() => <DialogAgent />)
        },
      },
      {
        name: "mcp.list",
        title: "Toggle MCPs",
        category: "Agent",
        slashName: "mcps",
        run: () => {
          dialog.replace(() => <DialogMcp />)
        },
      },
      {
        name: "agent.cycle",
        title: "Agent cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.agent.move(1)
        },
      },
      {
        name: "variant.cycle",
        title: "Variant cycle",
        category: "Agent",
        run: () => {
          local.model.variant.cycle()
        },
      },
      {
        name: "variant.list",
        title: "Switch model variant",
        category: "Agent",
        hidden: local.model.variant.list().length === 0,
        slashName: "variants",
        run: () => {
          if (local.model.variant.list().length === 0) {
            return toast.show({
              title: "No variants available",
              message: "The current model does not support any variants.",
              variant: "info",
            })
          }
          dialog.replace(() => <DialogVariant />)
        },
      },
      {
        name: "agent.cycle.reverse",
        title: "Agent cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.agent.move(-1)
        },
      },
      {
        name: "provider.connect",
        title: "Connect provider",
        suggested: !connected(),
        slashName: "connect",
        run: () => {
          dialog.replace(() => <DialogProviderList />)
        },
        category: "Provider",
      },
      ...(sync.data.console_state.switchableOrgCount > 1
        ? [
            {
              name: "console.org.switch",
              title: "Switch org",
              suggested: Boolean(sync.data.console_state.activeOrgName),
              slashName: "org",
              slashAliases: ["orgs", "switch-org"],
              run: () => {
                dialog.replace(() => <DialogConsoleOrg />)
              },
              category: "Provider",
            },
          ]
        : []),
      {
        name: "opencode.status",
        title: "View status",
        slashName: "status",
        run: () => {
          dialog.replace(() => <DialogStatus />)
        },
        category: "System",
      },
      // ── Hollycode memory/skill commands (parity with the Telegram gateway) ──
      {
        name: "hollycode.recall",
        title: "Recall — search past sessions",
        slashName: "recall",
        category: "Memory",
        run: async () => {
          const q = await DialogPrompt.show(dialog, "Recall — search past sessions", { placeholder: "keywords" })
          if (!q) return
          const res = await sdk.client.session.list({ search: q, limit: 10 } as any).catch(() => null)
          const all = (((res as any)?.data ?? (res as any)) ?? []) as any[]
          const lines = all.slice(0, 10).map((s: any) => `• ${s.title || s.id}`)
          DialogAlert.show(dialog, `Recall "${q}"`, lines.length ? lines.join("\n") : "No matching sessions.")
        },
      },
      {
        name: "hollycode.remember",
        title: "Remember a fact (AGENTS.md)",
        slashName: "remember",
        category: "Memory",
        run: async () => {
          const fact = await DialogPrompt.show(dialog, "Remember", { placeholder: "a durable fact to save" })
          if (!fact) return
          try {
            const dir = project.instance.directory() || process.cwd()
            const p = nodePath.join(dir, "AGENTS.md")
            let content = ""
            try { content = readFileSync(p, "utf8") } catch { /* new file */ }
            const header = "## Memory (added via /remember)"
            if (!content.includes(header)) content = content.trimEnd() + (content.trim() ? "\n\n" : "") + header + "\n"
            content = content.trimEnd() + `\n- ${fact}\n`
            writeFileSync(p, content)
            toast.show({ message: "🧠 Saved to AGENTS.md", variant: "success" })
          } catch (e: any) {
            toast.show({ message: `Could not save: ${e?.message ?? e}`, variant: "error" })
          }
        },
      },
      {
        name: "hollycode.profile",
        title: "User profile (what the agent knows about you)",
        slashName: "profile",
        category: "Memory",
        run: () => {
          const pf = nodePath.join(os.homedir(), ".config", "opencode", "AGENTS.md")
          let content = ""
          try { content = readFileSync(pf, "utf8") } catch { /* none yet */ }
          const m = content.match(/## About the user\s*([\s\S]*?)(?=\n## |\n# |$)/)
          const body = m ? m[1]!.trim() : ""
          DialogAlert.show(dialog, "Your profile", body || "No profile yet — chat and I'll learn who you are.")
        },
      },
      {
        name: "hollycode.curate",
        title: "Archive unused auto-skills",
        slashName: "curate",
        category: "Memory",
        run: () => {
          const base = nodePath.join(os.homedir(), ".config", "opencode", "skills", "auto")
          const archived: string[] = []
          try {
            if (existsSync(base)) {
              const maxAge = 30 * 86400000
              const archiveDir = nodePath.join(base, "_archived")
              for (const name of readdirSync(base)) {
                if (name === "_archived") continue
                const md = nodePath.join(base, name, "SKILL.md")
                if (!existsSync(md)) continue
                if (Date.now() - statSync(md).mtimeMs > maxAge) {
                  mkdirSync(archiveDir, { recursive: true })
                  renameSync(nodePath.join(base, name), nodePath.join(archiveDir, name))
                  archived.push(name)
                }
              }
            }
          } catch { /* best-effort */ }
          toast.show({
            message: archived.length ? `🧹 Archived ${archived.length} unused skill(s)` : "🧹 Nothing to archive",
            variant: "info",
          })
        },
      },
      {
        name: "hollycode.cost",
        title: "Cost — this session",
        slashName: "cost",
        category: "Memory",
        run: () => {
          const sid = route.data.type === "session" ? (route.data as any).sessionID : undefined
          if (!sid) {
            toast.show({ message: "Open a session first", variant: "info" })
            return
          }
          const s = sync.session.get(sid) as any
          const cost = s?.cost ?? 0
          DialogAlert.show(
            dialog,
            "Session cost",
            `$${cost.toFixed(4)} spent this session.\n\nThe sidebar shows live token usage. In Telegram, /cost also breaks down the stunt-double savings per model.`,
          )
        },
      },
      {
        name: "hollycode.tools",
        title: "Native tools (browser) — enable/disable",
        slashName: "tools",
        slashAliases: ["mcps"],
        category: "Memory",
        run: async () => {
          // Mirrors the gateway /tools command: toggles well-known MCP servers in
          // the project's opencode.json. opencode loads MCP at boot, so a restart
          // is needed for the change to take effect — same as the gateway reboot.
          const mcpBin = (name: string) =>
            fileURLToPath(new URL(`../../gateway/bin/hollycode-${name}-mcp.ts`, import.meta.url))
          const CATALOG: Record<string, { label: string; command: string[]; needsKey?: string }> = {
            browser: { label: "Browser (Playwright)", command: ["npx", "-y", "@playwright/mcp@latest"] },
            image: { label: "Image gen (FAL.ai)", command: [process.execPath, "run", mcpBin("image")], needsKey: "FAL_KEY" },
            video: { label: "Video gen (FAL.ai)", command: [process.execPath, "run", mcpBin("video")], needsKey: "FAL_KEY" },
            vision: { label: "Vision analysis (OpenAI-compatible)", command: [process.execPath, "run", mcpBin("vision")] },
            videoanalyze: { label: "Video analysis (frames + vision)", command: [process.execPath, "run", mcpBin("videoanalyze")] },
            computeruse: { label: "Computer use (desktop control)", command: [process.execPath, "run", mcpBin("computeruse")] },
            homeassistant: { label: "Home Assistant", command: [process.execPath, "run", mcpBin("homeassistant")], needsKey: "HA_TOKEN" },
            spotify: { label: "Spotify", command: [process.execPath, "run", mcpBin("spotify")], needsKey: "SPOTIFY_TOKEN" },
          }
          const dir = project.instance.directory() || process.cwd()
          const p = nodePath.join(dir, "opencode.json")
          let raw: any = { $schema: "https://opencode.ai/config.json" }
          try {
            if (existsSync(p)) raw = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""))
          } catch {
            toast.show({ message: "Could not parse opencode.json — edit mcp entries manually", variant: "error" })
            return
          }
          const state = Object.keys(CATALOG)
            .map((id) => `${id}=${raw?.mcp?.[id] && raw.mcp[id].enabled !== false ? "on" : "off"}`)
            .join("  ")
          const choice = await DialogPrompt.show(dialog, `Tools: ${state} — type "<id> on|off" (e.g. browser on)`, {
            placeholder: "browser on",
          })
          const parts = (choice ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)
          const id = parts[0]
          const want = parts[1]
          if (!id || !CATALOG[id] || (want !== "on" && want !== "off")) {
            if (choice) toast.show({ message: `Usage: <id> on|off — ids: ${Object.keys(CATALOG).join(", ")}`, variant: "info" })
            return
          }
          raw.mcp = raw.mcp ?? {}
          raw.mcp[id] = { type: "local", command: CATALOG[id]!.command, enabled: want === "on" }
          try {
            writeFileSync(p, JSON.stringify(raw, null, 2))
            const needsKey = CATALOG[id]!.needsKey
            const warn =
              want === "on" && needsKey && !process.env[needsKey] ? `\n\n⚠️ ${needsKey} is not set — set it for this tool to work.` : ""
            DialogAlert.show(
              dialog,
              "Native tools",
              `${id} is now ${want}. Restart hollycode for it to take effect.${warn}`,
            )
          } catch (e: any) {
            toast.show({ message: `Could not write config: ${e?.message ?? e}`, variant: "error" })
          }
        },
      },
      // ── Hollycode: insights, autoallow, personality, automemory ──
      {
        name: "hollycode.insights",
        title: "Insights — per-model usage stats",
        slashName: "insights",
        category: "Memory",
        run: async () => {
          const daysStr = await DialogPrompt.show(dialog, "Insights — number of days to look back", { placeholder: "7" })
          const days = parseInt(daysStr ?? "7", 10) || 7
          const since = Date.now() - days * 86400000
          const list = await sdk.client.session.list({} as any).catch(() => null)
          const all: any[] = ((list as any)?.data ?? []) as any[]
          const recent = all.filter((s: any) => ((s.time?.updated ?? s.time?.created ?? 0) >= since || true)).slice(0, 50)
          let sessionCount = 0
          let assistantMsgs = 0
          const models = new Map<string, number>()
          for (const s of recent) {
            const msgsRes = await sdk.client.session.messages({ sessionID: s.id }).catch(() => null)
            const data: any[] = ((msgsRes as any)?.data ?? []) as any[]
            let used = false
            for (const m of data) {
              const info = m.info ?? m
              if (info.role === "assistant" && info.modelID) {
                assistantMsgs++
                used = true
                const k = `${info.providerID}/${info.modelID}`
                models.set(k, (models.get(k) ?? 0) + 1)
              }
            }
            if (used) sessionCount++
          }
          const top = [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
          const lines = top.map(([k, n]) => `  ${k}: ${n} turns`)
          DialogAlert.show(
            dialog,
            `Insights — last ${days} days`,
            `Sessions with activity: ${sessionCount}\nAssistant turns: ${assistantMsgs}\n\nBy model:\n${lines.join("\n") || "  (none yet)"}\n\nTip: /cost shows stunt-double savings for the current session.`,
          )
        },
      },
      {
        name: "hollycode.autoallow",
        title: "Auto-allow — toggle automatic tool permission approval",
        slashName: "autoallow",
        category: "Memory",
        run: async () => {
          const current = kv.get("hollycode.autoallow", false) as boolean
          const choice = await DialogPrompt.show(
            dialog,
            `Auto-allow is ${current ? "ON (all tools approved automatically)" : "OFF (you approve each tool)"} — type on or off`,
            { placeholder: current ? "off" : "on" },
          )
          const want = (choice ?? "").trim().toLowerCase()
          if (want !== "on" && want !== "off") {
            if (choice !== null && choice !== undefined) toast.show({ message: "Type on or off", variant: "info" })
            return
          }
          const next = want === "on"
          if (next === current) {
            toast.show({ message: `Auto-allow already ${want}`, variant: "info" })
            return
          }
          kv.set("hollycode.autoallow", next)
          // Mirror gateway behaviour: write permission block to opencode.json in the project dir.
          try {
            const dir = project.instance.directory() || process.cwd()
            const p = nodePath.join(dir, "opencode.json")
            let raw: any = { $schema: "https://opencode.ai/config.json" }
            try { if (existsSync(p)) raw = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) } catch { /* ignore */ }
            raw.permission = next
              ? { external_directory: "allow", bash: "allow", read: "allow", write: "allow", edit: "allow", webfetch: "allow" }
              : { external_directory: "ask", bash: "ask", read: "allow", write: "ask", edit: "ask", webfetch: "allow" }
            writeFileSync(p, JSON.stringify(raw, null, 2))
          } catch { /* best-effort */ }
          toast.show({
            message: next
              ? "Auto-allow ON — all tool requests will be approved automatically"
              : "Auto-allow OFF — you will be asked to approve each tool request",
            variant: "success",
          })
          dialog.clear()
        },
      },
      {
        name: "hollycode.personality",
        title: "Personality — set the agent personality",
        slashName: "personality",
        category: "Memory",
        run: async () => {
          const PERSONALITIES: Record<string, string> = {
            default: "",
            concise: "Be terse and direct. Answer in as few words as correctness allows; skip preamble.",
            mentor: "Explain your reasoning as you go, teaching the user the why behind each step, patiently.",
            pirate: "Respond in the voice of a witty pirate, while keeping all technical content fully correct.",
            pair: "Act as a hands-on pair-programmer: think out loud, propose small steps, confirm before big changes.",
          }
          const current = (kv.get("hollycode.personality", "default") as string) || "default"
          const names = Object.keys(PERSONALITIES)
          const choice = await DialogPrompt.show(
            dialog,
            `Personality is: ${current}. Type a name (${names.join(", ")}) — or leave blank to see current`,
            { placeholder: current },
          )
          if (choice === null || choice === undefined) return
          const want = choice.trim().toLowerCase() || current
          if (!(want in PERSONALITIES)) {
            toast.show({ message: `Unknown personality. Choose: ${names.join(", ")}`, variant: "error" })
            return
          }
          kv.set("hollycode.personality", want)
          toast.show({
            message: want === "default"
              ? "Personality reset to default"
              : `Personality set to: ${want} — flavor text will be prepended to your next prompts`,
            variant: "success",
          })
          dialog.clear()
        },
      },
      {
        name: "hollycode.automemory",
        title: "Auto-memory — toggle silent post-turn memory curation",
        slashName: "automemory",
        category: "Memory",
        run: async () => {
          const current = kv.get("hollycode.automemory", true) as boolean
          const choice = await DialogPrompt.show(
            dialog,
            `Auto-memory is ${current ? "ON — I save durable facts to AGENTS.md after each turn" : "OFF"} — type on or off`,
            { placeholder: current ? "off" : "on" },
          )
          const want = (choice ?? "").trim().toLowerCase()
          if (want !== "on" && want !== "off") {
            if (choice !== null && choice !== undefined) toast.show({ message: "Type on or off", variant: "info" })
            return
          }
          const next = want === "on"
          if (next === current) {
            toast.show({ message: `Auto-memory already ${want}`, variant: "info" })
            return
          }
          kv.set("hollycode.automemory", next)
          toast.show({
            message: next
              ? "Auto-memory ON — I will silently save durable facts to AGENTS.md after each turn"
              : "Auto-memory OFF",
            variant: "success",
          })
          dialog.clear()
        },
      },
      // ── /debug — toggle verbose debug flag + show log location ──
      {
        name: "hollycode.debug",
        title: "Debug — toggle verbose logging",
        slashName: "debug",
        category: "System",
        run: () => {
          const current = kv.get("hollycode.debug", false) as boolean
          const next = !current
          kv.set("hollycode.debug", next)
          const logDir = nodePath.join(os.homedir(), ".hollycode", "logs")
          DialogAlert.show(
            dialog,
            `Debug mode ${next ? "ON" : "OFF"}`,
            next
              ? `Verbose logging is now enabled.\n\nLogs are written to:\n  ${logDir}\n\nToggle off with /debug again.`
              : "Verbose logging is now disabled.",
          )
        },
      },
      // ── /goal — set a goal directive injected into every outgoing prompt ──
      {
        name: "hollycode.goal",
        title: "Goal — set a persistent goal directive",
        slashName: "goal",
        slashAliases: ["objective"],
        category: "Memory",
        run: async () => {
          const current = (kv.get("hollycode.goal", "") as string) || ""
          const choice = await DialogPrompt.show(
            dialog,
            current
              ? `Current goal: "${current}"\n\nEnter a new goal, or type "off" / "clear" to remove it`
              : 'Enter your goal (e.g. "finish the auth flow") — leave blank to see current',
            { placeholder: current || "e.g. finish the auth flow" },
          )
          if (choice === null || choice === undefined) return
          const trimmed = choice.trim()
          if (trimmed === "" && current) {
            // blank input → show current without changing
            DialogAlert.show(dialog, "Current goal", current || "No goal set.")
            return
          }
          if (trimmed === "off" || trimmed === "clear" || trimmed === "") {
            kv.set("hollycode.goal", "")
            toast.show({ message: "Goal cleared — no directive will be injected", variant: "info" })
          } else {
            kv.set("hollycode.goal", trimmed)
            toast.show({ message: `Goal set: "${trimmed}"`, variant: "success" })
          }
          dialog.clear()
        },
      },
      // ── /loop — repeat a prompt on an interval until /loop stop ──
      {
        name: "hollycode.loop",
        title: "Loop — repeat a prompt on an interval (or stop)",
        slashName: "loop",
        category: "System",
        run: async () => {
          // If a loop is already running, show status and offer to stop.
          if (hollycodeLoopTimer !== undefined) {
            const choice = await DialogPrompt.show(
              dialog,
              `Loop is active (every ${hollycodeLoopSeconds}s): "${hollycodeLoopPrompt}"\n\nType "stop" to cancel, or press Escape to keep it running`,
              { placeholder: "stop" },
            )
            if ((choice ?? "").trim().toLowerCase() === "stop") {
              clearInterval(hollycodeLoopTimer)
              hollycodeLoopTimer = undefined
              toast.show({ message: "Loop stopped", variant: "info" })
              dialog.clear()
            }
            return
          }

          const input = await DialogPrompt.show(
            dialog,
            'Loop — format: "<seconds> | <prompt>" (min 30s)\nExample: "60 | summarize progress"\nOr type "stop" to cancel any running loop',
            { placeholder: "60 | summarize progress" },
          )
          if (!input) return
          const trimmed = input.trim()
          if (trimmed.toLowerCase() === "stop") {
            toast.show({ message: "No loop is currently running", variant: "info" })
            dialog.clear()
            return
          }

          const pipeIdx = trimmed.indexOf("|")
          if (pipeIdx === -1) {
            toast.show({ message: 'Usage: "<seconds> | <prompt>" — e.g. "60 | summarize progress"', variant: "error" })
            return
          }
          const secondsStr = trimmed.slice(0, pipeIdx).trim()
          const loopPromptText = trimmed.slice(pipeIdx + 1).trim()
          const seconds = parseInt(secondsStr, 10)
          if (!loopPromptText || isNaN(seconds) || seconds < 30) {
            toast.show({ message: "Minimum interval is 30 seconds", variant: "error" })
            return
          }

          hollycodeLoopSeconds = seconds
          hollycodeLoopPrompt = loopPromptText

          const fireLoop = () => {
            // Inject the loop prompt into the TUI prompt input and submit it.
            const ref = promptRef.current
            if (!ref) {
              toast.show({ message: "Loop: no active prompt — stopping", variant: "warning" })
              clearInterval(hollycodeLoopTimer)
              hollycodeLoopTimer = undefined
              return
            }
            ref.set({ input: loopPromptText, parts: [] })
            ref.submit()
          }

          // Fire immediately, then on the interval.
          fireLoop()
          hollycodeLoopTimer = setInterval(fireLoop, seconds * 1000) as unknown as ReturnType<typeof setInterval>

          toast.show({
            message: `Loop started: every ${seconds}s — run /loop to stop`,
            variant: "success",
            duration: 5000,
          })
          dialog.clear()
        },
      },
      {
        name: "remote.control",
        title: "Remote control (Telegram)",
        slashName: "remote-control",
        slashAliases: ["remote", "telegram"],
        category: "System",
        run: () => {
          // The setup wizard is interactive (paste token, pair phone), so it
          // runs in its OWN terminal window — the bridge must outlive the TUI.
          const dir = project.instance.directory() || process.cwd()
          const binTs = fileURLToPath(new URL("../../gateway/bin/hollycode-gateway.ts", import.meta.url))
          // --directory is explicit: with a saved config the launcher would
          // otherwise reuse the previously configured project folder.
          const launcher =
            (existsSync(binTs) ? `"${process.execPath}" run "${binTs}"` : "hollycode-gateway") + ` --directory "${dir}"`
          try {
            if (process.platform === "win32") {
              // cmd strips the first+last quote of the /k argument when it contains
              // several quoted paths — the extra outer quotes absorb that.
              const child = spawn(
                "cmd.exe",
                ["/c", `start "Hollywood Remote Control" /D "${dir}" cmd /k "${launcher}"`],
                {
                  detached: true,
                  stdio: "ignore",
                  windowsVerbatimArguments: true,
                },
              )
              child.unref()
            } else if (process.platform === "darwin") {
              const script = `tell application "Terminal"\nactivate\ndo script "cd ${JSON.stringify(dir)} && ${launcher.replaceAll('"', '\\"')}"\nend tell`
              const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" })
              child.unref()
            } else {
              const sh = `cd ${JSON.stringify(dir)} && ${launcher}`
              const child = spawn(
                "sh",
                ["-c", `(x-terminal-emulator -e sh -c '${sh}' || gnome-terminal -- sh -c '${sh}' || konsole -e sh -c '${sh}' || xterm -e sh -c '${sh}') >/dev/null 2>&1 &`],
                { detached: true, stdio: "ignore" },
              )
              child.unref()
            }
            toast.show({
              message: "Gateway setup opened in a new terminal window — follow the steps there",
              variant: "success",
            })
          } catch {
            toast.show({ message: "Could not open a terminal — run `hollycode-gateway` manually", variant: "error" })
          }
          dialog.clear()
        },
      },
      {
        name: "hollycode.autostart",
        title: "Auto-start the gateway on boot",
        slashName: "autostart",
        slashAliases: ["startup"],
        category: "System",
        run: async () => {
          // Manage the gateway's OS auto-start (Task Scheduler / launchd / systemd)
          // by shelling out to the gateway launcher's flags — same mechanism as
          // `hollycode-gateway --install-startup`.
          const binTs = fileURLToPath(new URL("../../gateway/bin/hollycode-gateway.ts", import.meta.url))
          const runFlag = (flag: string) => {
            const r = existsSync(binTs)
              ? spawnSync(process.execPath, ["run", binTs, flag], { encoding: "utf8" })
              : spawnSync("hollycode-gateway", [flag], { encoding: "utf8", shell: true })
            return ((r.stdout ?? "") + (r.stderr ?? "")).trim()
          }
          const status = runFlag("--startup-status")
          const on = status.includes("installed") && !status.includes("not installed")
          const choice = await DialogPrompt.show(
            dialog,
            `Auto-start is ${on ? "ON" : "OFF"} — type on or off`,
            { placeholder: on ? "off" : "on" },
          )
          const want = (choice ?? "").trim().toLowerCase()
          if (want !== "on" && want !== "off") return
          const out = runFlag(want === "on" ? "--install-startup" : "--remove-startup")
          DialogAlert.show(dialog, "Auto-start", out || `Auto-start ${want === "on" ? "enabled" : "disabled"}.`)
        },
      },
      {
        name: "hollycode.setup",
        title: "Setup / onboarding (choose tools)",
        slashName: "setup",
        slashAliases: ["onboarding", "onboard"],
        category: "System",
        run: () => {
          dialog.replace(() => <DialogOnboarding />)
        },
      },
      // ── /doctor — install health check ──
      {
        name: "hollycode.doctor",
        title: "Doctor — diagnose the installation",
        slashName: "doctor",
        category: "System",
        run: async () => {
          const home = os.homedir()
          const checks: { label: string; ok: boolean }[] = []

          // 1. hollycode executable
          const hollycodeExe = nodePath.join(home, ".hollycode", "hollycode.exe")
          const hollycodeAlt = nodePath.join(home, ".hollycode", "hollycode")
          checks.push({
            label: "hollycode.exe in ~/.hollycode",
            ok: existsSync(hollycodeExe) || existsSync(hollycodeAlt),
          })

          // 2. launcher in ~/.bun/bin
          const bunBin = nodePath.join(home, ".bun", "bin", "hollycode")
          const bunBinExe = nodePath.join(home, ".bun", "bin", "hollycode.exe")
          checks.push({
            label: "launcher in ~/.bun/bin",
            ok: existsSync(bunBin) || existsSync(bunBinExe),
          })

          // 3. @opentui/solid node_modules
          const opentui = nodePath.join(home, ".hollycode", "node_modules", "@opentui", "solid")
          checks.push({
            label: "@opentui/solid in ~/.hollycode/node_modules",
            ok: existsSync(opentui),
          })

          // 4. opencode auth
          const authPaths = [
            nodePath.join(home, ".local", "share", "opencode", "auth.json"),
            nodePath.join(home, ".local", "share", "opencode", "account.json"),
            nodePath.join(home, "AppData", "Roaming", "opencode", "auth.json"),
            nodePath.join(home, "AppData", "Roaming", "opencode", "account.json"),
          ]
          checks.push({
            label: "opencode auth file exists",
            ok: authPaths.some((p) => existsSync(p)),
          })

          // 5. server reachable (we're already connected — check providers config)
          let serverOk = false
          try {
            const res = await sdk.client.config.providers().catch(() => null)
            serverOk = res != null
          } catch { /* offline */ }
          checks.push({ label: "opencode server reachable", ok: serverOk })

          const lines = checks.map((c) => `${c.ok ? "✅" : "⚠️"} ${c.label}`)
          const allOk = checks.every((c) => c.ok)
          DialogAlert.show(
            dialog,
            "Doctor — install health",
            `${lines.join("\n")}\n\n${allOk ? "Everything looks good!" : "Some checks failed — see above."}`,
          )
        },
      },
      // ── /permissions — view/edit per-tool permission rules ──
      {
        name: "hollycode.permissions",
        title: "Permissions — view/edit tool permission rules",
        slashName: "permissions",
        slashAliases: ["perm", "perms"],
        category: "System",
        run: async () => {
          const TOOLS = ["bash", "edit", "write", "read", "webfetch", "external_directory"] as const
          type PermValue = "allow" | "ask" | "deny"
          const dir = project.instance.directory() || process.cwd()
          const p = nodePath.join(dir, "opencode.json")

          // Read current config
          let raw: any = { $schema: "https://opencode.ai/config.json" }
          try { if (existsSync(p)) raw = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) } catch { /* new */ }
          const perm: Record<string, PermValue> = typeof raw.permission === "object" && raw.permission !== null
            ? raw.permission as Record<string, PermValue>
            : {}

          const currentState = TOOLS.map((t) => `${t}=${perm[t] ?? "ask"}`).join("  ")
          const choice = await DialogPrompt.show(
            dialog,
            `Permissions: ${currentState}\nType "<tool> allow|ask|deny" to change (e.g. bash allow)`,
            { placeholder: "bash allow" },
          )
          if (!choice) return

          const parts = choice.trim().toLowerCase().split(/\s+/).filter(Boolean)
          const tool = parts[0] as typeof TOOLS[number]
          const want = parts[1] as PermValue | undefined

          if (!tool || !(TOOLS as readonly string[]).includes(tool) || !["allow", "ask", "deny"].includes(want ?? "")) {
            if (choice) toast.show({ message: `Usage: <tool> allow|ask|deny — tools: ${TOOLS.join(", ")}`, variant: "info" })
            return
          }

          raw.permission = { ...perm, [tool]: want }
          try {
            writeFileSync(p, JSON.stringify(raw, null, 2))
            toast.show({ message: `${tool} → ${want} (saved to opencode.json)`, variant: "success" })
          } catch (e: any) {
            toast.show({ message: `Could not write opencode.json: ${e?.message ?? e}`, variant: "error" })
          }
          dialog.clear()
        },
      },
      {
        name: "theme.switch",
        title: "Switch theme",
        slashName: "themes",
        run: () => {
          dialog.replace(() => <DialogThemeList />)
        },
        category: "System",
      },
      {
        name: "theme.switch_mode",
        title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
        run: () => {
          setMode(mode() === "dark" ? "light" : "dark")
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "theme.mode.lock",
        title: locked() ? "Unlock theme mode" : "Lock theme mode",
        run: () => {
          if (locked()) unlock()
          else lock()
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "help.show",
        title: "Help",
        slashName: "help",
        run: () => {
          dialog.replace(() => <DialogHelp />)
        },
        category: "System",
      },
      {
        name: "docs.open",
        title: "Open docs",
        run: () => {
          open("https://opencode.ai/docs").catch(() => {})
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "app.exit",
        title: "Exit the app",
        slashName: "exit",
        slashAliases: ["quit", "q"],
        run: () => exit(),
        category: "System",
      },
      {
        name: "app.debug",
        title: "Toggle debug panel",
        category: "System",
        run: () => {
          renderer.toggleDebugOverlay()
          dialog.clear()
        },
      },
      {
        name: "app.console",
        title: "Toggle console",
        category: "System",
        run: () => {
          renderer.console.toggle()
          dialog.clear()
        },
      },
      {
        name: "app.heap_snapshot",
        title: "Write heap snapshot",
        category: "System",
        run: async () => {
          const files = await props.onSnapshot?.()
          toast.show({
            variant: "info",
            message: `Heap snapshot written to ${files?.join(", ")}`,
            duration: 5000,
          })
          dialog.clear()
        },
      },
      {
        name: "terminal.suspend",
        title: "Suspend terminal",
        category: "System",
        hidden: true,
        enabled: process.platform !== "win32",
        run: () => {
          renderer.suspend()
          process.once("SIGCONT", () => renderer.resume())
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
        category: "System",
        run: () => {
          setTerminalTitleEnabled((prev) => {
            const next = !prev
            kv.set("terminal_title_enabled", next)
            if (!next) renderer.setTerminalTitle("")
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
        category: "System",
        run: () => {
          kv.set("animations_enabled", !kv.get("animations_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.file_context",
        title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
        category: "System",
        run: () => {
          kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
        category: "System",
        run: () => {
          const current = kv.get("diff_wrap_mode", "word")
          kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
        category: "System",
        run: () => {
          setPasteSummaryEnabled((prev) => {
            const next = !prev
            kv.set("paste_summary_enabled", next)
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.session_directory_filter",
        title: kv.get("session_directory_filter_enabled", true)
          ? "Disable session directory filtering"
          : "Enable session directory filtering",
        category: "System",
        run: async () => {
          kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
          await sync.session.refresh()
          dialog.clear()
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  )

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  event.on("tui.command.execute", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on("tui.session.select", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  event.on("installation.update-available", async (evt) => {
    console.log("installation.update-available", evt)
    const version = evt.properties.version

    const skipped = kv.get("skipped_version")
    if (skipped && !isVersionGreater(version, skipped)) return

    const choice = await DialogConfirm.show(
      dialog,
      `Update Available`,
      `A new release v${version} is available. Would you like to update now?`,
      "skip",
    )

    if (choice === false) {
      kv.set("skipped_version", version)
      return
    }

    if (choice !== true) return

    toast.show({
      variant: "info",
      message: `Updating to v${version}...`,
      duration: 30000,
    })

    const result = await sdk.client.global.upgrade({ target: version })

    if (result.error || !result.data?.success) {
      toast.show({
        variant: "error",
        title: "Update Failed",
        message: "Update failed",
        duration: 10000,
      })
      return
    }

    await DialogAlert.show(
      dialog,
      "Update Complete",
      `Successfully updated to OpenCode v${result.data.version}. Please restart the application.`,
    )

    void exit()
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    const render = pluginRuntime.routes.get(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        !Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
          ? () => Selection.copy(renderer, toast, clipboard)
          : undefined
      }
    >
      <Show when={Flag.OPENCODE_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
                {(_) => <Session />}
              </Show>
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>
        <pluginRuntime.Slot name="app" />
      </Show>
      <Show when={!startup.skipInitialLoading}>
        <StartupLoading ready={ready} />
      </Show>
    </box>
  )
}
