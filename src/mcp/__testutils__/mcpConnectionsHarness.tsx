// Mounting `useManageMCPConnections` over in-process fakes.
//
// The hook reaches its collaborators as module functions (config loading,
// connecting, reconnecting, cache clearing), so the seam is `spyOn` on the
// namespaces it imports from — never `mock.module`, which leaks across the
// whole run. Every spy is restored by `restore()`.
//
// The real `setTimeout` is wrapped so the reconnect backoff (1 s … 30 s) can be
// recorded and, optionally, shrunk to 1 ms: the schedule stays observable
// without a test waiting on it.
//
// NOT a `.test` file — it exports helpers, it does not register tests.

import { spyOn } from 'bun:test'
import * as React from 'react'
import { useState } from 'react'

import * as claudeai from 'src/mcp/claudeai.js'
import * as mcpClient from 'src/mcp/client.js'
import * as mcpConfig from 'src/mcp/config.js'
import { resetSessionDisconnectsForTests } from 'src/mcp/sessionDisconnects.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from 'src/mcp/types.js'
import { useManageMCPConnections } from 'src/mcp/useManageMCPConnections.js'
import {
  mountHook,
  waitForCondition,
} from 'src/providers/ui/__testutils__/inkHookHarness.js'
import type { Command } from 'src/commands/commands.js'
import type { PluginError } from 'src/shared/types/plugin.js'
import type { Tool } from 'src/tools/Tool.js'
import {
  AppStateProvider,
  useAppStateStore,
  type AppState,
} from 'src/terminal/state/AppState.js'

export type ConnectionResult = {
  client: MCPServerConnection
  tools: Tool[]
  commands: Command[]
  resources?: ServerResource[]
}

type Store = ReturnType<typeof useAppStateStore>
type Api = ReturnType<typeof useManageMCPConnections>

export function httpConfig(url: string, scope = 'local'): ScopedMcpServerConfig {
  return { type: 'http', url, scope } as ScopedMcpServerConfig
}

export function stdioConfig(command: string, scope = 'local'): ScopedMcpServerConfig {
  return { command, args: [], scope } as unknown as ScopedMcpServerConfig
}

export function fakeTool(server: string, name: string): Tool {
  return { name: `mcp__${server}__${name}`, isMcp: true } as unknown as Tool
}

export function fakeCommand(server: string, name: string): Command {
  return { name: `mcp__${server}__${name}`, type: 'prompt', isMcp: true } as unknown as Command
}

export function fakeResource(server: string, uri: string): ServerResource {
  return { uri, name: uri, server }
}

export type FakeSdkClient = {
  onclose?: () => void
  setNotificationHandler: (method: string, handler: () => Promise<void>) => void
  setRequestHandler: (method: string, handler: unknown) => void
  notificationHandlers: Map<string, () => Promise<void>>
  requestHandlers: string[]
}

/** A stand-in for the SDK `Client`: it records what the hook registers on it. */
export function fakeSdkClient(): FakeSdkClient {
  const notificationHandlers = new Map<string, () => Promise<void>>()
  const requestHandlers: string[] = []
  return {
    onclose: undefined,
    notificationHandlers,
    requestHandlers,
    setNotificationHandler(method, handler) {
      notificationHandlers.set(method, handler)
    },
    setRequestHandler(method) {
      requestHandlers.push(method)
    },
  }
}

export function connected(
  name: string,
  config: ScopedMcpServerConfig,
  options: {
    capabilities?: ConnectedMCPServer['capabilities']
    sdk?: FakeSdkClient
    tools?: Tool[]
    commands?: Command[]
    resources?: ServerResource[]
  } = {},
): ConnectionResult & { sdk: FakeSdkClient; client: ConnectedMCPServer } {
  const sdk = options.sdk ?? fakeSdkClient()
  const client = {
    type: 'connected',
    name,
    config,
    capabilities: options.capabilities ?? {},
    client: sdk,
    cleanup: async () => {},
  } as unknown as ConnectedMCPServer
  return {
    client,
    sdk,
    tools: options.tools ?? [],
    commands: options.commands ?? [],
    resources: options.resources,
  }
}

export function failed(name: string, config: ScopedMcpServerConfig): ConnectionResult {
  return { client: { type: 'failed', name, config, error: 'boom' }, tools: [], commands: [] }
}

export function needsAuth(name: string, config: ScopedMcpServerConfig): ConnectionResult {
  return { client: { type: 'needs-auth', name, config }, tools: [], commands: [] }
}

export type Fakes = ReturnType<typeof installMcpFakes>

/**
 * Spy every collaborator the hook reaches. Defaults: no configs on disk, no
 * claude.ai connectors, nothing disabled, every server connects with no tools.
 */
export function installMcpFakes() {
  const fakes = {
    servers: {} as Record<string, ScopedMcpServerConfig>,
    configErrors: [] as PluginError[],
    claudeai: {} as Record<string, ScopedMcpServerConfig>,
    enterprise: false,
    disabled: new Set<string>(),
    /** What a connect of `name` resolves to; `undefined` → connected, no tools. */
    connect: (name: string, config: ScopedMcpServerConfig): ConnectionResult | Promise<ConnectionResult> =>
      connected(name, config),
    /** What `reconnectMcpServerImpl` answers, in call order; the last repeats. */
    reconnect: [] as Array<ConnectionResult | Error>,
    connectBatches: [] as Array<Record<string, ScopedMcpServerConfig>>,
    reconnectCalls: [] as Array<[string, ScopedMcpServerConfig]>,
    /** Every `setTimeout` delay of 1 s or more, i.e. the reconnect backoff. */
    backoffDelays: [] as number[],
    /** The handles those calls returned, in the same order. */
    backoffTimers: [] as unknown[],
    /** When true, backoff timers fire after 1 ms instead of their real delay. */
    shrinkBackoff: true,
  }

  const realSetTimeout = globalThis.setTimeout
  const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (typeof ms === 'number' && ms >= 1000) {
      fakes.backoffDelays.push(ms)
      const handle = realSetTimeout(fn, fakes.shrinkBackoff ? 1 : ms, ...rest)
      fakes.backoffTimers.push(handle)
      return handle
    }
    return realSetTimeout(fn, ms, ...rest)
  }) as unknown as typeof setTimeout)
  const getClaudeCodeMcpConfigs = spyOn(mcpConfig, 'getClaudeCodeMcpConfigs').mockImplementation(async () => ({
    servers: { ...fakes.servers },
    errors: [...fakes.configErrors],
  }))
  // Memoized exports: the spy stands in for the memo, so its `.cache` is never read.
  const doesEnterpriseMcpConfigExist = spyOn(mcpConfig, 'doesEnterpriseMcpConfigExist').mockImplementation(
    (() => fakes.enterprise) as typeof mcpConfig.doesEnterpriseMcpConfigExist,
  )
  const isMcpServerDisabled = spyOn(mcpConfig, 'isMcpServerDisabled').mockImplementation((name: string) =>
    fakes.disabled.has(name),
  )
  const setMcpServerEnabled = spyOn(mcpConfig, 'setMcpServerEnabled').mockImplementation(
    (name: string, enabled: boolean) => {
      if (enabled) fakes.disabled.delete(name)
      else fakes.disabled.add(name)
    },
  )
  const clearClaudeAIMcpConfigsCache = spyOn(claudeai, 'clearClaudeAIMcpConfigsCache').mockImplementation(() => {})
  const fetchClaudeAIMcpConfigsIfEligible = spyOn(claudeai, 'fetchClaudeAIMcpConfigsIfEligible').mockImplementation(
    (async () => ({ ...fakes.claudeai })) as typeof claudeai.fetchClaudeAIMcpConfigsIfEligible,
  )
  const getMcpToolsCommandsAndResources = spyOn(mcpClient, 'getMcpToolsCommandsAndResources').mockImplementation(
    (async (onConnectionAttempt: (r: ConnectionResult) => void, configs: Record<string, ScopedMcpServerConfig>) => {
      fakes.connectBatches.push(configs)
      await Promise.all(
        Object.entries(configs).map(async ([name, config]) => {
          onConnectionAttempt(await fakes.connect(name, config))
        }),
      )
    }) as unknown as typeof mcpClient.getMcpToolsCommandsAndResources,
  )
  const reconnectMcpServerImpl = spyOn(mcpClient, 'reconnectMcpServerImpl').mockImplementation(
    (async (name: string, config: ScopedMcpServerConfig) => {
      fakes.reconnectCalls.push([name, config])
      const next = fakes.reconnect.length > 1 ? fakes.reconnect.shift() : fakes.reconnect[0]
      if (next === undefined) return connected(name, config)
      if (next instanceof Error) throw next
      return next
    }) as unknown as typeof mcpClient.reconnectMcpServerImpl,
  )
  const clearServerCache = spyOn(mcpClient, 'clearServerCache').mockImplementation(async () => {})

  const all = [
    setTimeoutSpy,
    getClaudeCodeMcpConfigs,
    doesEnterpriseMcpConfigExist,
    isMcpServerDisabled,
    setMcpServerEnabled,
    clearClaudeAIMcpConfigsCache,
    fetchClaudeAIMcpConfigsIfEligible,
    getMcpToolsCommandsAndResources,
    reconnectMcpServerImpl,
    clearServerCache,
  ]

  return {
    fakes,
    spies: {
      getClaudeCodeMcpConfigs,
      clearClaudeAIMcpConfigsCache,
      fetchClaudeAIMcpConfigsIfEligible,
      getMcpToolsCommandsAndResources,
      reconnectMcpServerImpl,
      clearServerCache,
      setMcpServerEnabled,
    },
    restore() {
      for (const spy of all) spy.mockRestore()
      resetSessionDisconnectsForTests()
    },
  }
}

export type Harness = {
  api: () => Api
  state: () => AppState
  store: () => Store
  /** Every committed AppState, oldest first. */
  history: AppState[]
  setDynamic: (next: Record<string, ScopedMcpServerConfig> | undefined) => void
  until: (predicate: (s: AppState) => boolean, label: string) => Promise<void>
  cleanup: () => Promise<void>
}

export function clientTypes(s: AppState): Record<string, string> {
  return Object.fromEntries(s.mcp.clients.map(c => [c.name, c.type]))
}

export async function mountConnections(
  dynamic?: Record<string, ScopedMcpServerConfig>,
  options: { strict?: boolean } = {},
): Promise<Harness> {
  let api: Api | undefined
  let store: Store | undefined
  let setDynamic: Harness['setDynamic'] = () => {}
  const history: AppState[] = []

  function Host(): React.ReactNode {
    const [config, setConfig] = useState(dynamic)
    setDynamic = setConfig
    store = useAppStateStore()
    api = useManageMCPConnections(config, options.strict ?? false)
    return null
  }

  const mounted = await mountHook(
    <AppStateProvider onChangeAppState={({ newState }) => history.push(newState)}>
      <Host />
    </AppStateProvider>,
  )
  await waitForCondition(() => api !== undefined, { label: 'the hook to mount' })

  const harness: Harness = {
    api: () => api!,
    store: () => store!,
    state: () => store!.getState(),
    history,
    setDynamic: next => setDynamic(next),
    until: (predicate, label) =>
      waitForCondition(() => predicate(store!.getState()), { label, timeoutMs: 3000 }).catch(err => {
        throw new Error(
          `${(err as Error).message}\nclients: ${JSON.stringify(clientTypes(store!.getState()))}`,
        )
      }),
    cleanup: mounted.cleanup,
  }
  return harness
}

/** A promise whose resolution the test controls. */
export function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
