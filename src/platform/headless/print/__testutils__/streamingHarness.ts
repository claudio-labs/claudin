/**
 * A headless streaming session for the characterization suites of
 * `src/platform/headless/print/`, assembled the way `runHeadlessStreaming`
 * assembles it: a real `StructuredIO` over a stdin the test writes NDJSON
 * lines into, the real outbound stream, an AppState held in a closure, and the
 * context's wiring pointed at the real `mcpRuntime` units.
 *
 * Two thunks are not real. `run` would start the turn loop, which calls the
 * model, so it only counts; `closeOutput` ends the outbound stream instead of
 * tearing down process listeners nobody installed. Any thunk can be replaced
 * through `wiring`, and every thunk call is counted in `calls`.
 */
import { afterAll, beforeAll } from 'bun:test'
import { randomUUID } from 'crypto'

import type { MCPServerConnection, McpSdkServerConfig } from 'src/mcp/types.js'
import type { StdoutMessage } from 'src/platform/entrypoints/sdk/controlTypes.js'
import * as runtime from 'src/platform/headless/print/mcpRuntime.js'
import type {
  HeadlessStreamingContext,
  HeadlessStreamingOptions,
} from 'src/platform/headless/print/streamingContext.js'
import { StructuredIO } from 'src/platform/headless/structuredIO.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import type { Message } from 'src/shared/types/message.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type { Tools } from 'src/tools/Tool.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { Command } from 'src/commands/commands.js'

type Wiring = Pick<
  HeadlessStreamingContext,
  | 'run'
  | 'updateSdkMcp'
  | 'applyMcpServerChanges'
  | 'refreshPluginState'
  | 'applyPluginMcpDiff'
  | 'buildAllTools'
  | 'registerElicitationHandlers'
  | 'buildMcpServerStatuses'
  | 'forwardMessagesToBridge'
  | 'injectModelSwitchBreadcrumbs'
  | 'closeOutput'
>

export type SessionSetup = {
  options?: Partial<HeadlessStreamingOptions>
  mcpClients?: MCPServerConnection[]
  sdkMcpConfigs?: Record<string, McpSdkServerConfig>
  tools?: Tools
  commands?: Command[]
  agents?: AgentDefinition[]
  messages?: Message[]
  appState?: Partial<AppState>
  replayUserMessages?: boolean
  wiring?: Partial<Wiring>
}

export type HeadlessSession = {
  ctx: HeadlessStreamingContext
  /** Write messages to stdin, one NDJSON line each. */
  send(...messages: object[]): void
  /** Close stdin. */
  end(): void
  /** Everything the session wrote to its outbound stream, in order. */
  readonly emitted: StdoutMessage[]
  /** How many times each wiring thunk was called. */
  readonly calls: Record<keyof Wiring, number>
  /** The appState as it is now. */
  state(): AppState
  /** The control_response answering `requestId`, once it has been written. */
  answer(requestId: string): Promise<ControlAnswer>
}

export type ControlAnswer = {
  subtype: 'success' | 'error'
  request_id: string
  response?: Record<string, unknown>
  error?: string
}

/** A stdin the test writes into: an async iterable of text chunks. */
function writableStdin() {
  const chunks: string[] = []
  let closed = false
  let wake: (() => void) | undefined
  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (chunks.length > 0) {
          yield chunks.shift()!
          continue
        }
        if (closed) return
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    },
  }
  const poke = () => {
    const waiting = wake
    wake = undefined
    waiting?.()
  }
  return {
    iterable,
    write(text: string) {
      chunks.push(text)
      poke()
    },
    close() {
      closed = true
      poke()
    },
  }
}

export function openSession(setup: SessionSetup = {}): HeadlessSession {
  const stdin = writableStdin()
  const structuredIO = new StructuredIO(stdin.iterable, setup.replayUserMessages)
  const output = structuredIO.outbound
  const emitted: StdoutMessage[] = []
  void (async () => {
    for await (const message of output) emitted.push(message)
  })()

  let appState: AppState = { ...getDefaultAppState(), ...setup.appState }
  const getAppState = () => appState
  const setAppState = (update: (prev: AppState) => AppState) => {
    appState = update(appState)
  }

  const options: HeadlessStreamingOptions = {
    verbose: undefined,
    jsonSchema: undefined,
    permissionPromptToolName: undefined,
    allowedTools: undefined,
    thinkingConfig: undefined,
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    taskBudget: undefined,
    systemPrompt: undefined,
    appendSystemPrompt: undefined,
    userSpecifiedModel: undefined,
    fallbackModel: undefined,
    ...setup.options,
  }

  const calls = {
    run: 0,
    updateSdkMcp: 0,
    applyMcpServerChanges: 0,
    refreshPluginState: 0,
    applyPluginMcpDiff: 0,
    buildAllTools: 0,
    registerElicitationHandlers: 0,
    buildMcpServerStatuses: 0,
    forwardMessagesToBridge: 0,
    injectModelSwitchBreadcrumbs: 0,
    closeOutput: 0,
  } satisfies Record<keyof Wiring, number>

  const real: Wiring = {
    run: async () => {},
    updateSdkMcp: () => runtime.updateSdkMcp(ctx),
    applyMcpServerChanges: servers => runtime.applyMcpServerChanges(ctx, servers),
    refreshPluginState: () => runtime.refreshPluginState(ctx),
    applyPluginMcpDiff: () => runtime.applyPluginMcpDiff(ctx),
    buildAllTools: state => runtime.buildAllTools(ctx, state),
    registerElicitationHandlers: clients => runtime.registerElicitationHandlers(ctx, clients),
    buildMcpServerStatuses: () => runtime.buildMcpServerStatuses(ctx),
    forwardMessagesToBridge: () => runtime.forwardMessagesToBridge(ctx),
    injectModelSwitchBreadcrumbs: () => {},
    closeOutput: async () => {
      output.done()
    },
  }
  const chosen: Wiring = { ...real, ...setup.wiring }
  const counted = Object.fromEntries(
    Object.entries(chosen).map(([name, thunk]) => [
      name,
      (...args: unknown[]) => {
        calls[name as keyof Wiring]++
        return (thunk as (...a: unknown[]) => unknown)(...args)
      },
    ]),
  ) as unknown as Wiring

  const messages = setup.messages ?? []
  const ctx: HeadlessStreamingContext = {
    structuredIO,
    output,
    initialMcpClients: setup.mcpClients ?? [],
    baseTools: setup.tools ?? [],
    initialCommands: setup.commands ?? [],
    initialAgents: setup.agents ?? [],
    canUseTool: (async () => ({ behavior: 'allow' })) as unknown as HeadlessStreamingContext['canUseTool'],
    getAppState,
    setAppState,
    options,
    sdkMcpConfigs: setup.sdkMcpConfigs ?? {},
    mutableMessages: messages,
    pendingSeeds: createFileStateCacheWithSizeLimit(100),
    suggestionState: {
      abortController: null,
      inflightPromise: null,
      lastEmitted: null,
      pendingSuggestion: null,
      pendingLastEmittedEntry: null,
    },
    elicitationRegistered: new Set(),
    modelInfos: [],
    idleTimeout: { start() {}, stop() {} } as unknown as HeadlessStreamingContext['idleTimeout'],
    activeOAuthFlows: new Map(),
    oauthCallbackSubmitters: new Map(),
    oauthManualCallbackUsed: new Set(),
    oauthAuthPromises: new Map(),

    running: false,
    runPhase: undefined,
    inputClosed: false,
    shutdownPromptInjected: false,
    heldBackResult: null,
    abortController: undefined,
    readFileState: createFileStateCacheWithSizeLimit(100),
    activeUserSpecifiedModel: options.userSpecifiedModel,
    sdkClients: [],
    sdkTools: [],
    dynamicMcpState: { clients: [], tools: [], configs: {} },
    bridgeHandle: null,
    bridgeLastForwardedIndex: 0,
    mcpChangesPromise: Promise.resolve({
      response: { added: [], removed: [], errors: {} },
      sdkServersChanged: false,
    }),
    pluginInstallPromise: null,
    currentCommands: setup.commands ?? [],
    currentAgents: setup.agents ?? [],
    cronScheduler: null,
    claudeOAuth: null,

    ...counted,
    sendControlResponseSuccess: (message, response) => {
      output.enqueue({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response },
      })
    },
    sendControlResponseError: (message, error) => {
      output.enqueue({
        type: 'control_response',
        response: { subtype: 'error', request_id: message.request_id, error },
      })
    },
  }

  const answer = async (requestId: string): Promise<ControlAnswer> => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const found = emitted.find(
        message =>
          message.type === 'control_response' &&
          (message.response as { request_id?: string }).request_id === requestId,
      )
      if (found) return (found as { response: ControlAnswer }).response
      if (Date.now() > deadline) throw new Error(`no control_response for ${requestId}`)
      await Bun.sleep(5)
    }
  }

  return {
    ctx,
    send(...lines) {
      stdin.write(lines.map(line => JSON.stringify(line) + '\n').join(''))
    },
    end: () => stdin.close(),
    emitted,
    calls,
    state: getAppState,
    answer,
  }
}

/** A control_request line, with a fresh request id unless one is given. */
export function controlRequest(
  request: { subtype: string } & Record<string, unknown>,
  requestId: string = randomUUID(),
): { type: 'control_request'; request_id: string; request: typeof request } {
  return { type: 'control_request', request_id: requestId, request }
}

/**
 * `MACRO` is a constant the build inlines; under `bun test` it exists only if
 * some suite defined it. The MCP client reads `MACRO.VERSION` when it connects,
 * so a file that connects one defines it for its own run and puts it back.
 */
export function useBuildMacro(): void {
  const scope = globalThis as unknown as { MACRO?: { VERSION?: string } }
  let before: { VERSION?: string } | undefined
  beforeAll(() => {
    before = scope.MACRO
    scope.MACRO = { ...before, VERSION: before?.VERSION ?? '0.0.0-test' }
  })
  afterAll(() => {
    if (before === undefined) delete scope.MACRO
    else scope.MACRO = before
  })
}
