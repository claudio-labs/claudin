import { afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ClientCapabilities, Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'

import {
  clearRegisteredHooks,
  getRegisteredHooks,
  registerHookCallbacks,
} from 'src/platform/bootstrap/state.js'
import type { HookInput } from 'src/platform/entrypoints/agentSdkTypes.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'
import type { AppState } from 'src/terminal/state/AppState.js'

/** A real SDK Client/Server pair over the in-memory transport. */
export async function linkedPair({
  clientCapabilities = { elicitation: { form: {}, url: {} } },
  setupServer,
  beforeConnect,
}: {
  clientCapabilities?: ClientCapabilities
  setupServer?: (server: Server) => void
  /** Runs on the client before connect, e.g. to register handlers. */
  beforeConnect?: (client: Client) => void
} = {}): Promise<{ client: Client; server: Server; close: () => Promise<void> }> {
  const server = new Server(
    { name: 'fixture', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )
  setupServer?.(server)
  const client = new Client(
    { name: 'claudin-test', version: '0.0.0' },
    { capabilities: clientCapabilities },
  )
  beforeConnect?.(client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ])
  return {
    client,
    server,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

export const STDIO_CONFIG: ScopedMcpServerConfig = {
  scope: 'user',
  type: 'stdio',
  command: 'fixture',
  args: [],
} as ScopedMcpServerConfig

export function connectedServer(
  client: Client,
  name = 'fixture',
  config: ScopedMcpServerConfig = STDIO_CONFIG,
): ConnectedMCPServer {
  return {
    type: 'connected',
    name,
    client,
    capabilities: client.getServerCapabilities() ?? {},
    config,
    cleanup: async () => {},
  }
}

/** The slice of AppState the elicitation code reads and writes. */
export function appStateBox(): {
  get: () => AppState
  set: (f: (prev: AppState) => AppState) => void
  queue: () => AppState['elicitation']['queue']
} {
  let state = { elicitation: { queue: [] } } as unknown as AppState
  return {
    get: () => state,
    set: f => {
      state = f(state)
    },
    queue: () => state.elicitation.queue,
  }
}

/** Resolves once `predicate` holds, polling the microtask/timer queue briefly. */
export async function waitUntil(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

type HookEventName = 'Elicitation' | 'ElicitationResult'

/**
 * Registers real lifecycle hooks for the calling file: command hooks that
 * print a JSON answer for Elicitation/ElicitationResult (the documented way a
 * hook answers), and a callback Notification hook that records every
 * notification the elicitation code fires. Restores the registered hooks and
 * the config dir after each test.
 */
export function useElicitationHooks(): {
  answer: (event: HookEventName, json: Record<string, unknown>) => void
  notifications: Array<{ type: string; message: string }>
  inputs: HookInput[]
} {
  const notifications: Array<{ type: string; message: string }> = []
  const inputs: HookInput[] = []
  let saved: ReturnType<typeof getRegisteredHooks> = null
  let savedConfigDir: string | undefined
  let dir = ''
  const resetCaches = async () => {
    const { resetSettingsCache } = await import('src/platform/settings/settingsCache.js')
    const { resetHooksConfigSnapshot } = await import(
      'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
    )
    resetSettingsCache()
    resetHooksConfigSnapshot()
    // Memoized by cwd only: a hook that reads the transcript path while the
    // config dir points here would pin it for every later file in the run.
    const { getProjectDir } = await import('src/sessions/pure/paths.js')
    getProjectDir.cache.clear?.()
  }
  beforeEach(async () => {
    savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
    dir = mkdtempSync(join(tmpdir(), 'elicit-hooks-'))
    process.env.CLAUDIN_CONFIG_DIR = dir
    await resetCaches()
    saved = getRegisteredHooks()
    clearRegisteredHooks()
    notifications.length = 0
    inputs.length = 0
    registerHookCallbacks({
      Notification: [
        {
          matcher: '',
          hooks: [
            {
              type: 'callback',
              callback: async (input: HookInput) => {
                const n = input as HookInput & { message: string; notification_type: string }
                notifications.push({ type: n.notification_type, message: n.message })
                return {}
              },
            },
          ],
        },
      ],
      Elicitation: [recorder(inputs)],
      ElicitationResult: [recorder(inputs)],
    } as never)
  })
  afterEach(async () => {
    clearRegisteredHooks()
    if (saved) registerHookCallbacks(saved)
    if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
    await resetCaches()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    notifications,
    inputs,
    answer: (event, json) => {
      registerHookCallbacks({
        [event]: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: `printf '%s' '${JSON.stringify(json)}'` }],
            pluginRoot: dir,
            pluginName: 'elicit-probe',
          },
        ],
      } as never)
    },
  }
}

function recorder(inputs: HookInput[]) {
  return {
    matcher: '',
    hooks: [
      {
        type: 'callback',
        callback: async (input: HookInput) => {
          inputs.push(input)
          return {}
        },
      },
    ],
  }
}
