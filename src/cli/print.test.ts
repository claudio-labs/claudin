/**
 * Characterization tests for src/cli/print.ts ahead of the 11b split.
 *
 * Goal: pin behavior of the units that will move out (promptBatching,
 * uuidDedupe, structuredIOFactory, orphanPermission, mcpReconcile,
 * getCanUseToolFn, removeInterruptedMessage) so the extraction commits
 * stay byte-equivalent. Mocks only at module boundaries (MCP client,
 * StructuredIO/RemoteIO), never on internal logic.
 *
 * See plan: /home/viudes/.claudio/plans/valiant-watching-hanrahan.md
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

// Mocks must register before the SUT is imported. Imports are inside
// describe blocks so each group can stage its own boundary mocks.

// Capture the real MCP modules before any describe block mocks them, so
// afterAll can restore them. Without this, the boundary mocks (e.g.
// areMcpConfigsEqual stubbed to `() => true`) leak into other test files
// in the same `bun test` run.
const realMcpClient = { ...(await import('src/services/mcp/client.js')) }
const realMcpConfig = { ...(await import('src/services/mcp/config.js')) }

describe('promptBatching', () => {
  test('joinPromptValues: single string passes through unchanged', async () => {
    const { joinPromptValues } = await import('./print.js')
    expect(joinPromptValues(['hello'])).toBe('hello')
  })

  test('joinPromptValues: all-strings newline-joined', async () => {
    const { joinPromptValues } = await import('./print.js')
    expect(joinPromptValues(['a', 'b', 'c'])).toBe('a\nb\nc')
  })

  test('joinPromptValues: any block array → flatMap to blocks', async () => {
    const { joinPromptValues } = await import('./print.js')
    const out = joinPromptValues([
      'hi',
      [{ type: 'text', text: 'world' }],
    ])
    expect(out).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'world' },
    ])
  })

  test('joinPromptValues: single block array passes through unchanged', async () => {
    const { joinPromptValues } = await import('./print.js')
    const blocks = [{ type: 'text' as const, text: 'only' }]
    expect(joinPromptValues([blocks])).toBe(blocks)
  })

  test('canBatchWith: undefined next → false', async () => {
    const { canBatchWith } = await import('./print.js')
    const head = { value: 'a', mode: 'prompt' as const }
    expect(canBatchWith(head, undefined)).toBe(false)
  })

  test('canBatchWith: mode mismatch → false', async () => {
    const { canBatchWith } = await import('./print.js')
    const head = { value: 'a', mode: 'prompt' as const }
    const next = { value: 'b', mode: 'bash' as const }
    expect(canBatchWith(head, next)).toBe(false)
  })

  test('canBatchWith: isMeta mismatch (proactive vs user) → false', async () => {
    const { canBatchWith } = await import('./print.js')
    const userHead = { value: 'a', mode: 'prompt' as const, isMeta: false }
    const metaNext = { value: 'b', mode: 'prompt' as const, isMeta: true }
    expect(canBatchWith(userHead, metaNext)).toBe(false)
    expect(canBatchWith(metaNext, userHead)).toBe(false)
  })

  test('canBatchWith: same mode + same isMeta → true', async () => {
    const { canBatchWith } = await import('./print.js')
    const head = { value: 'a', mode: 'prompt' as const, isMeta: false }
    const next = { value: 'b', mode: 'prompt' as const, isMeta: false }
    expect(canBatchWith(head, next)).toBe(true)
  })
})

describe('uuidDedupe', () => {
  test('first insertion returns true, duplicate returns false', async () => {
    const { trackReceivedMessageUuid, __resetForTests } = await import(
      './print/uuidDedupe.js'
    )
    __resetForTests()
    const uuid = '00000000-0000-0000-0000-000000000001' as never
    expect(trackReceivedMessageUuid(uuid)).toBe(true)
    expect(trackReceivedMessageUuid(uuid)).toBe(false)
  })

  test('hasReceivedMessageUuid reflects tracked state', async () => {
    const { trackReceivedMessageUuid, hasReceivedMessageUuid, __resetForTests } =
      await import('./print/uuidDedupe.js')
    __resetForTests()
    const uuid = '00000000-0000-0000-0000-000000000002' as never
    expect(hasReceivedMessageUuid(uuid)).toBe(false)
    trackReceivedMessageUuid(uuid)
    expect(hasReceivedMessageUuid(uuid)).toBe(true)
  })

  test('FIFO eviction at MAX_RECEIVED_UUIDS boundary (oldest dropped)', async () => {
    const { trackReceivedMessageUuid, hasReceivedMessageUuid, __resetForTests } =
      await import('./print/uuidDedupe.js')
    __resetForTests()
    const MAX = 10_000
    const mk = (n: number): never =>
      `aaaaaaaa-0000-0000-0000-${n.toString().padStart(12, '0')}` as never
    for (let i = 0; i < MAX; i++) trackReceivedMessageUuid(mk(i))
    expect(hasReceivedMessageUuid(mk(0))).toBe(true)
    // One past capacity → oldest entry (index 0) evicted
    trackReceivedMessageUuid(mk(MAX))
    expect(hasReceivedMessageUuid(mk(0))).toBe(false)
    expect(hasReceivedMessageUuid(mk(1))).toBe(true)
    expect(hasReceivedMessageUuid(mk(MAX))).toBe(true)
  })
})

describe('removeInterruptedMessage', () => {
  test('removes user message and following sentinel', async () => {
    const { removeInterruptedMessage } = await import('./print.js')
    const target = { uuid: 'u-target' } as unknown
    const messages = [
      { uuid: 'u-before' },
      target,
      { uuid: 'u-sentinel' },
      { uuid: 'u-after' },
    ] as never
    removeInterruptedMessage(messages, target as never)
    expect(messages.map((m: { uuid: string }) => m.uuid)).toEqual([
      'u-before',
      'u-after',
    ])
  })

  test('no-op when uuid not found', async () => {
    const { removeInterruptedMessage } = await import('./print.js')
    const messages = [{ uuid: 'a' }, { uuid: 'b' }] as never
    removeInterruptedMessage(messages, { uuid: 'missing' } as never)
    expect((messages as Array<{ uuid: string }>).map(m => m.uuid)).toEqual([
      'a',
      'b',
    ])
  })

  test('splice tolerates target at last position (no sentinel to drop)', async () => {
    const { removeInterruptedMessage } = await import('./print.js')
    const target = { uuid: 'last' } as unknown
    const messages = [{ uuid: 'a' }, target] as never
    removeInterruptedMessage(messages, target as never)
    expect((messages as Array<{ uuid: string }>).map(m => m.uuid)).toEqual([
      'a',
    ])
  })
})

describe('handleOrphanedPermissionResponse', () => {
  test('dedupe guard: second call for same toolUseID returns false', async () => {
    // Boundary mock: prevent findUnresolvedToolUse from doing real work
    mock.module('src/utils/sessionStorage.js', () => ({
      findUnresolvedToolUse: async (_id: string) => ({
        message: { id: 'asst-1' },
      }),
      hydrateRemoteSession: async () => undefined,
      hydrateFromCCRv2InternalEvents: async () => undefined,
      resetSessionFilePointer: () => {},
      doesMessageExistInSession: async () => false,
      recordAttributionSnapshot: async () => {},
      saveAgentSetting: async () => {},
      saveMode: async () => {},
      saveAiGeneratedTitle: async () => {},
      restoreSessionMetadata: async () => null,
    }))
    const { handleOrphanedPermissionResponse } = await import('./print.js')

    const handled = new Set<string>()
    const baseMessage = {
      response: {
        subtype: 'success',
        request_id: 'r-1',
        response: { toolUseID: 'tool-abc' },
      },
    } as never
    const setAppState = () => {}

    const first = await handleOrphanedPermissionResponse({
      message: baseMessage,
      setAppState,
      handledToolUseIds: handled,
    })
    const second = await handleOrphanedPermissionResponse({
      message: baseMessage,
      setAppState,
      handledToolUseIds: handled,
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(handled.has('tool-abc')).toBe(true)
  })

  test('returns false when subtype is not success', async () => {
    const { handleOrphanedPermissionResponse } = await import('./print.js')
    const out = await handleOrphanedPermissionResponse({
      message: {
        response: { subtype: 'error', request_id: 'r', response: {} },
      } as never,
      setAppState: () => {},
      handledToolUseIds: new Set<string>(),
    })
    expect(out).toBe(false)
  })

  test('returns false when toolUseID is missing', async () => {
    const { handleOrphanedPermissionResponse } = await import('./print.js')
    const out = await handleOrphanedPermissionResponse({
      message: {
        response: { subtype: 'success', request_id: 'r', response: {} },
      } as never,
      setAppState: () => {},
      handledToolUseIds: new Set<string>(),
    })
    expect(out).toBe(false)
  })
})

describe('mcpReconcile', () => {
  type ConnectCall = { name: string; config: unknown }
  type CleanupCall = string

  function stageMcpMocks(opts: {
    connectImpl?: (
      name: string,
      config: unknown,
    ) => Promise<{ type: string; name: string; error?: string; cleanup?: () => Promise<void> }>
    fetchToolsImpl?: (client: { name: string }) => Promise<Array<{ name: string }>>
  }) {
    const connectCalls: ConnectCall[] = []
    const fetchCalls: string[] = []
    const cleanupCalls: CleanupCall[] = []
    const clearCacheCalls: string[] = []

    mock.module('src/services/mcp/client.js', () => ({
      setupSdkMcpClients: async () => [],
      connectToServer: async (name: string, config: unknown) => {
        connectCalls.push({ name, config })
        if (opts.connectImpl) return opts.connectImpl(name, config)
        return {
          type: 'connected',
          name,
          cleanup: async () => {
            cleanupCalls.push(name)
          },
        }
      },
      clearServerCache: async (name: string) => {
        clearCacheCalls.push(name)
      },
      fetchToolsForClient: async (client: { name: string }) => {
        fetchCalls.push(client.name)
        return opts.fetchToolsImpl
          ? opts.fetchToolsImpl(client)
          : [{ name: `mcp__${client.name}__tool1` }]
      },
      areMcpConfigsEqual: (a: unknown, b: unknown) =>
        JSON.stringify(a) === JSON.stringify(b),
      reconnectMcpServerImpl: async () => undefined,
    }))

    mock.module('src/services/mcp/config.js', () => ({
      filterMcpServersByPolicy: (servers: Record<string, unknown>) => ({
        allowed: servers,
        blocked: [] as string[],
      }),
      getMcpConfigByName: () => undefined,
      isMcpServerDisabled: () => false,
      setMcpServerEnabled: () => {},
    }))

    return { connectCalls, fetchCalls, cleanupCalls, clearCacheCalls }
  }

  function emptyAppState() {
    return {
      mcp: {
        tools: [] as Array<{ name: string }>,
        clients: [] as Array<{ name: string }>,
      },
    }
  }

  test('add new server: connect + fetch tools, report in added', async () => {
    const mocks = stageMcpMocks({})
    const { reconcileMcpServers } = await import('./print.js')

    let appState = emptyAppState()
    const setAppState = (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    }

    const result = await reconcileMcpServers(
      { srv1: { type: 'stdio', command: 'foo' } as never },
      { clients: [], tools: [], configs: {} },
      setAppState as never,
    )

    expect(result.response.added).toEqual(['srv1'])
    expect(result.response.removed).toEqual([])
    expect(mocks.connectCalls.map(c => c.name)).toEqual(['srv1'])
    expect(mocks.fetchCalls).toEqual(['srv1'])
    expect(appState.mcp.tools.map(t => t.name)).toEqual(['mcp__srv1__tool1'])
  })

  test('remove gone server: cleanup + tools filtered out', async () => {
    const cleanupCalls: string[] = []
    stageMcpMocks({})

    const { reconcileMcpServers } = await import('./print.js')

    let appState = {
      mcp: {
        tools: [
          { name: 'mcp__old__tool1' },
          { name: 'mcp__other__tool1' },
        ],
        clients: [{ name: 'old' }],
      },
    }
    const setAppState = (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    }

    const oldClient = {
      type: 'connected' as const,
      name: 'old',
      cleanup: async () => {
        cleanupCalls.push('old')
      },
    }

    const result = await reconcileMcpServers(
      {},
      {
        clients: [oldClient as never],
        tools: [{ name: 'mcp__old__tool1' } as never],
        configs: { old: { type: 'stdio', command: 'x', scope: 'dynamic' } as never },
      },
      setAppState as never,
    )

    expect(result.response.removed).toEqual(['old'])
    expect(result.response.added).toEqual([])
    expect(cleanupCalls).toEqual(['old'])
    expect(appState.mcp.tools.map(t => t.name)).toEqual(['mcp__other__tool1'])
  })

  test('unchanged server: no connect, no cleanup, no removal', async () => {
    const mocks = stageMcpMocks({})
    const { reconcileMcpServers } = await import('./print.js')

    const sameConfig = { type: 'stdio', command: 'same' }
    let appState = emptyAppState()
    const setAppState = (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    }

    const result = await reconcileMcpServers(
      { keep: sameConfig as never },
      {
        clients: [],
        tools: [],
        configs: { keep: { ...sameConfig, scope: 'dynamic' } as never },
      },
      setAppState as never,
    )

    expect(result.response.added).toEqual([])
    expect(result.response.removed).toEqual([])
    expect(mocks.connectCalls).toEqual([])
  })

  test('connect throws → errors populated, not in added', async () => {
    stageMcpMocks({
      connectImpl: async () => {
        throw new Error('boom')
      },
    })
    const { reconcileMcpServers } = await import('./print.js')

    let appState = emptyAppState()
    const setAppState = (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    }

    const result = await reconcileMcpServers(
      { broken: { type: 'stdio', command: 'x' } as never },
      { clients: [], tools: [], configs: {} },
      setAppState as never,
    )

    expect(result.response.errors).toEqual({ broken: 'boom' })
    expect(result.response.added).toEqual([])
  })

  test("client type 'failed' → errors[name] populated from client.error", async () => {
    stageMcpMocks({
      connectImpl: async (name: string) => ({
        type: 'failed',
        name,
        error: 'auth denied',
      }),
    })
    const { reconcileMcpServers } = await import('./print.js')

    let appState = emptyAppState()
    const setAppState = (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    }

    const result = await reconcileMcpServers(
      { srv: { type: 'stdio', command: 'x' } as never },
      { clients: [], tools: [], configs: {} },
      setAppState as never,
    )

    expect(result.response.errors).toEqual({ srv: 'auth denied' })
    expect(result.response.added).toEqual(['srv'])
  })

  test("config.type === 'sdk' → tracked but no connect attempted", async () => {
    const mocks = stageMcpMocks({})
    const { reconcileMcpServers } = await import('./print.js')

    let appState = emptyAppState()
    const setAppState = (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    }

    const result = await reconcileMcpServers(
      { sdksrv: { type: 'sdk', name: 'sdksrv', instance: {} } as never },
      { clients: [], tools: [], configs: {} },
      setAppState as never,
    )

    expect(result.response.added).toEqual(['sdksrv'])
    expect(mocks.connectCalls).toEqual([])
  })
})

describe('getCanUseToolFn', () => {
  test("permissionPromptToolName 'stdio' → delegates to structuredIO.createCanUseTool", async () => {
    const { getCanUseToolFn } = await import('./print.js')

    const sentinel = () => Promise.resolve({ behavior: 'allow' as const })
    const fakeStructuredIO = {
      createCanUseTool: (_cb?: unknown) => sentinel,
    } as never

    const result = getCanUseToolFn('stdio', fakeStructuredIO, () => [])
    expect(result).toBe(sentinel as never)
  })

  test('no permissionPromptToolName → fallback uses hasPermissionsToUseTool', async () => {
    const { getCanUseToolFn } = await import('./print.js')
    const fn = getCanUseToolFn(undefined, {} as never, () => [])
    expect(typeof fn).toBe('function')
  })
})

describe('handleMcpSetServers', () => {
  test('policy-blocked servers appear in response.errors (regression: SDK V2 bypass)', async () => {
    mock.module('src/services/mcp/client.js', () => ({
      setupSdkMcpClients: async () => [],
      connectToServer: async () => ({ type: 'connected', name: 'x', cleanup: async () => {} }),
      clearServerCache: async () => {},
      fetchToolsForClient: async () => [],
      areMcpConfigsEqual: () => true,
      reconnectMcpServerImpl: async () => undefined,
    }))
    mock.module('src/services/mcp/config.js', () => ({
      filterMcpServersByPolicy: (servers: Record<string, unknown>) => ({
        allowed: {},
        blocked: Object.keys(servers),
      }),
      getMcpConfigByName: () => undefined,
      isMcpServerDisabled: () => false,
      setMcpServerEnabled: () => {},
    }))

    const { handleMcpSetServers } = await import('./print.js')

    const result = await handleMcpSetServers(
      { evil: { type: 'stdio', command: 'rm -rf /' } as never },
      { configs: {}, clients: [], tools: [] },
      { clients: [], tools: [], configs: {} },
      (() => {}) as never,
    )

    expect(result.response.errors).toEqual({
      evil: 'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)',
    })
    expect(result.response.added).toEqual([])
  })
})

afterAll(() => {
  // Restore the real MCP modules so the boundary mocks staged above don't
  // leak into other test files sharing this `bun test` process.
  mock.module('src/services/mcp/client.js', () => realMcpClient)
  mock.module('src/services/mcp/config.js', () => realMcpConfig)
})
