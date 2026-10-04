/**
 * The mcp/capabilities rewrite: its fix decision (the sweep decides
 * "disabled" in one place) and the pure pieces the characterization suite
 * reaches only through live servers.
 */
import { describe, expect, test } from 'bun:test'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import type { Tool } from 'src/tools/Tool.js'
import type { OAuthTokens } from 'src/providers/oauth/types.js'
import type { APIProvider } from 'src/providers/model/providers.js'
import { type ListingFacts, listingEligibility } from 'src/mcp/claudeaiConnectors/eligibility.js'
import { nameConnectors } from 'src/mcp/claudeaiConnectors/naming.js'
import { fetchCommandsForClient, fetchResourcesForClient, fetchToolsForClient } from 'src/mcp/client.js'
import { promptArguments } from 'src/mcp/client/capabilities/promptCommand.js'
import { withRetries } from 'src/mcp/client/capabilities/retry.js'
import { classifyServer, resourceToolsMissingFrom, type ServerFacts, type SweepPlan } from 'src/mcp/client/capabilities/sweep.js'
import { pickMcpMeta, toTelemetrySafe } from 'src/mcp/client/capabilities/toolCall.js'
import { capDescription, readAlwaysLoad, readSearchHint } from 'src/mcp/client/capabilities/toolFromListing.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { createVscodeChannel } from 'src/mcp/vscodeChannel.js'

const cfg = (type: string | undefined) =>
  ({ ...(type ? { type } : {}), url: 'https://x.example', command: 'x', scope: 'user' }) as unknown as ScopedMcpServerConfig

describe('fix 5: the sweep decides "disabled" once, before anything else', () => {
  const none: ServerFacts = { disabled: false, needsAuthCached: false, probedWithoutToken: false }
  const cases: Array<[string | undefined, Partial<ServerFacts>, SweepPlan]> = [
    ['http', { disabled: true, needsAuthCached: true, probedWithoutToken: true }, 'disabled'],
    [undefined, { disabled: true }, 'disabled'],
    ['sdk', { disabled: true }, 'disabled'],
    ['http', { needsAuthCached: true }, 'needs-auth'],
    ['sse', { needsAuthCached: true }, 'needs-auth'],
    ['claudeai-proxy', { needsAuthCached: true }, 'needs-auth'],
    ['http', { probedWithoutToken: true }, 'needs-auth'],
    ['sse', { probedWithoutToken: true }, 'needs-auth'],
    ['claudeai-proxy', { probedWithoutToken: true }, 'connect'],
    ['stdio', { needsAuthCached: true, probedWithoutToken: true }, 'connect'],
    [undefined, { needsAuthCached: true }, 'connect'],
    ['ws', { needsAuthCached: true, probedWithoutToken: true }, 'connect'],
    ['sdk', { needsAuthCached: true }, 'connect'],
    ['http', {}, 'connect'],
  ]
  for (const [type, facts, plan] of cases) {
    test(`${type ?? 'untyped'} ${JSON.stringify(facts)} -> ${plan}`, () => {
      expect(classifyServer(cfg(type), { ...none, ...facts })).toBe(plan)
    })
  }
})

describe('a connected server without the capability', () => {
  // A real server answers an undeclared method with an error, which the
  // fetchers turn into []; only a recording client can tell "never asked".
  test('is never asked for tools, resources or prompts', async () => {
    const asked: string[] = []
    const record = {
      name: `no-capabilities-${process.pid}`,
      type: 'connected',
      capabilities: {},
      config: { type: 'sdk', name: 'x', scope: 'dynamic' },
      client: {
        request: async ({ method }: { method: string }) => {
          asked.push(method)
          throw new Error('not offered')
        },
      },
      cleanup: async () => {},
    } as unknown as MCPServerConnection
    try {
      const results = await Promise.all([
        fetchToolsForClient(record),
        fetchResourcesForClient(record),
        fetchCommandsForClient(record),
      ])
      expect({ results, asked }).toEqual({ results: [[], [], []], asked: [] })
    } finally {
      for (const fetcher of [fetchToolsForClient, fetchResourcesForClient, fetchCommandsForClient]) {
        fetcher.cache.delete(record.name)
      }
    }
  }, 10_000)
})

describe('withRetries', () => {
  test('waits the listed delays between attempts and gives up after the last', async () => {
    const waits: number[] = []
    const retried: number[] = []
    let calls = 0
    const failing = withRetries(
      async () => {
        calls++
        throw new Error(`boom ${calls}`)
      },
      3,
      [1_000, 2_000],
      { wait: async ms => void waits.push(ms), onRetry: attempt => void retried.push(attempt) },
    )
    await expect(failing).rejects.toThrow('boom 3')
    expect({ calls, waits, retried }).toEqual({ calls: 3, waits: [1_000, 2_000], retried: [1, 2] })
  })

  test('returns the first success without waiting further, and reuses the last delay', async () => {
    const waits: number[] = []
    let calls = 0
    const value = await withRetries(
      async () => {
        if (++calls < 4) throw new Error('not yet')
        return 'ok'
      },
      5,
      [10, 20],
      { wait: async ms => void waits.push(ms) },
    )
    expect({ value, calls, waits }).toEqual({ value: 'ok', calls: 4, waits: [10, 20, 20] })
  })
})

describe('tool listing helpers', () => {
  test('descriptions are capped at 2048 characters with a marker', () => {
    const cases: Array<[number, string]> = [
      [0, ''],
      [2048, 'a'.repeat(2048)],
      [2049, `${'a'.repeat(2048)}… [truncated]`],
    ]
    for (const [length, expected] of cases) expect(capDescription('a'.repeat(length))).toBe(expected)
  })

  test('search hints collapse whitespace; only a literal true loads always', () => {
    const hints: Array<[unknown, string | undefined]> = [
      ['  a\n\tb  c ', 'a b c'],
      ['\n \t', undefined],
      ['', undefined],
      [42, undefined],
      [undefined, undefined],
    ]
    for (const [raw, expected] of hints) expect(readSearchHint({ 'anthropic/searchHint': raw })).toBe(expected)
    expect(readSearchHint(undefined)).toBeUndefined()
    const loads: Array<[unknown, boolean]> = [[true, true], ['true', false], [1, false], [undefined, false]]
    for (const [raw, expected] of loads) expect(readAlwaysLoad({ 'anthropic/alwaysLoad': raw })).toBe(expected)
  })

  test('the resource tools are left out when the server already offers those names', () => {
    const own = (name: string) => ({ name }) as Tool
    expect(resourceToolsMissingFrom([own('mcp__s__x')]).map(t => t.name)).toEqual(['ListMcpResourcesTool', 'ReadMcpResourceTool'])
    expect(resourceToolsMissingFrom([own('ListMcpResourcesTool')]).map(t => t.name)).toEqual(['ReadMcpResourceTool'])
    expect(resourceToolsMissingFrom([own('ListMcpResourcesTool'), own('ReadMcpResourceTool')])).toEqual([])
  })
})

describe('calling a tool', () => {
  test('mcpMeta holds only what the server sent', () => {
    const cases: Array<[Parameters<typeof pickMcpMeta>[0], ReturnType<typeof pickMcpMeta>]> = [
      [{}, undefined],
      [{ _meta: { a: 1 } }, { _meta: { a: 1 } }],
      [{ structuredContent: { n: 1 } }, { structuredContent: { n: 1 } }],
      [{ _meta: { a: 1 }, structuredContent: { n: 1 } }, { _meta: { a: 1 }, structuredContent: { n: 1 } }],
    ]
    for (const [outcome, expected] of cases) expect(pickMcpMeta(outcome)).toEqual(expected)
  })

  test('plain and SDK errors become telemetry-safe with the same message; safe ones and non-errors pass', () => {
    for (const error of [new Error('disk on fire'), new McpError(ErrorCode.InternalError, 'disk on fire')]) {
      const wrapped = toTelemetrySafe(error) as Error
      expect(wrapped).toBeInstanceOf(TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      expect(wrapped.message).toBe(error.message)
      expect(wrapped).not.toBe(error)
    }
    const safe = new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS('m', 't')
    expect(toTelemetrySafe(safe)).toBe(safe)
    expect(toTelemetrySafe('a string')).toBe('a string')
  })
})

describe('prompt arguments', () => {
  test('are positional words split on single spaces (kept for parity)', () => {
    const cases: Array<[string[], string, Record<string, string | undefined>]> = [
      [['a', 'b'], 'x y', { a: 'x', b: 'y' }],
      [['a', 'b'], 'x y z', { a: 'x', b: 'y' }],
      [['a', 'b'], 'x', { a: 'x', b: undefined }],
      [['a', 'b'], 'x  y', { a: 'x', b: '' }],
      [[], 'anything', {}],
    ]
    for (const [names, typed, expected] of cases) expect(promptArguments(names, typed)).toEqual(expected)
  })
})

describe('claude.ai connectors', () => {
  const tokens = (scopes: string[]): OAuthTokens =>
    ({ accessToken: 'tok', refreshToken: null, expiresAt: null, scopes, subscriptionType: null, rateLimitTier: null })
  const open: ListingFacts = {
    provider: 'firstParty',
    essentialTrafficOnly: false,
    switchedOff: false,
    readTokens: () => tokens(['user:mcp_servers']),
  }

  test('eligibility names the first gate that refuses', () => {
    const cases: Array<[Partial<ListingFacts>, ReturnType<typeof listingEligibility>]> = [
      [{}, { eligible: true, accessToken: 'tok' }],
      [{ provider: 'bedrock' as APIProvider }, { eligible: false, reason: 'not-first-party' }],
      [{ essentialTrafficOnly: true }, { eligible: false, reason: 'essential-traffic' }],
      [{ switchedOff: true }, { eligible: false, reason: 'switched-off' }],
      [{ readTokens: () => null }, { eligible: false, reason: 'no-login' }],
      [{ readTokens: () => tokens(['user:inference']) }, { eligible: false, reason: 'missing-scope' }],
    ]
    for (const [facts, expected] of cases) expect(listingEligibility({ ...open, ...facts })).toEqual(expected)
  })

  test('tokens are not read when an earlier gate refuses', () => {
    let reads = 0
    const readTokens = () => {
      reads++
      return null
    }
    for (const facts of [{ provider: 'vertex' as APIProvider }, { essentialTrafficOnly: true }, { switchedOff: true }]) {
      listingEligibility({ ...open, ...facts, readTokens })
    }
    expect(reads).toBe(0)
  })

  test('names that normalize alike are numbered until free', () => {
    const listed = (id: string, display_name: string) => ({ id, display_name, url: `https://m/${id}` })
    const names = Object.keys(
      nameConnectors([listed('1', 'A b'), listed('2', 'A-b'), listed('3', 'A b'), listed('4', 'A b (2)'), listed('5', 'Other')]),
    )
    expect(names).toEqual(['claude.ai A b', 'claude.ai A-b', 'claude.ai A b (2)', 'claude.ai A b (2) (2)', 'claude.ai Other'])
    expect(nameConnectors([listed('1', 'X')])['claude.ai X']).toEqual({ type: 'claudeai-proxy', url: 'https://m/1', id: '1', scope: 'claudeai' })
  })
})

describe('the VS Code channel object', () => {
  type Sent = { method: string; params: unknown }
  function server(name: string, type: MCPServerConnection['type'], sent: Sent[], fail = false) {
    const notification = async (note: Sent) => {
      if (fail) throw new Error('closed')
      sent.push(note)
    }
    return { name, type, config: {}, client: { notification } } as unknown as MCPServerConnection
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  test('adopts only a connected claude-vscode, and keeps it across an update without one', async () => {
    const sent: Sent[] = []
    const channel = createVscodeChannel({ onSendFailure: () => {} })
    channel.fileUpdated('/a', null, 'x')
    channel.adopt([server('claude-vscode', 'failed', sent), server('other', 'connected', sent)])
    channel.fileUpdated('/b', null, 'x')
    channel.adopt([server('claude-vscode', 'connected', sent)])
    channel.adopt([server('other', 'connected', sent)])
    channel.fileUpdated('/c', 'old', null)
    await flush()
    expect(sent).toEqual([{ method: 'file_updated', params: { filePath: '/c', oldContent: 'old', newContent: null } }])
  })

  test('a failed send is reported to the failure hook, never thrown', async () => {
    const failures: unknown[] = []
    const channel = createVscodeChannel({ onSendFailure: e => void failures.push(e) })
    channel.adopt([server('claude-vscode', 'connected', [], true)])
    expect(() => channel.fileUpdated('/a', 'x', 'y')).not.toThrow()
    await flush()
    expect(failures.map(e => (e as Error).message)).toEqual(['closed'])
  })
})
