import { describe, expect, test } from 'bun:test'
import { type McpCliAuthDeps, runMcpLogin, runMcpLogout } from 'src/mcp/auth/cliLogin.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'

const httpServer: ScopedMcpServerConfig = { type: 'http', url: 'https://srv.example/mcp', scope: 'user' }

type Calls = { flows: unknown[][]; revoked: unknown[][]; written: string[]; submitted: string[] }

function deps(overrides: Partial<McpCliAuthDeps> = {}, configs: Record<string, ScopedMcpServerConfig> = { srv: httpServer }) {
  const calls: Calls = { flows: [], revoked: [], written: [], submitted: [] }
  const base: McpCliAuthDeps = {
    getConfig: name => configs[name] ?? null,
    performFlow: async (...args) => {
      calls.flows.push(args)
      args[2]('https://auth.example/authorize?client_id=c')
    },
    revoke: async (...args) => {
      calls.revoked.push(args)
    },
    readLine: null,
    write: text => {
      calls.written.push(text)
    },
  }
  return { deps: { ...base, ...overrides }, calls }
}

describe('runMcpLogin', () => {
  test('runs the OAuth flow for the server and prints the authorization URL', async () => {
    const { deps: d, calls } = deps()
    const result = await runMcpLogin('srv', d)
    expect(result).toEqual({ ok: true, message: 'Authenticated with "srv".' })
    expect(calls.flows).toHaveLength(1)
    expect(calls.flows[0]!.slice(0, 2)).toEqual(['srv', httpServer])
    expect(calls.written.join('')).toContain('https://auth.example/authorize?client_id=c')
  })

  test('an sse server signs in too', async () => {
    const sse: ScopedMcpServerConfig = { type: 'sse', url: 'https://srv.example/sse', scope: 'project' }
    const { deps: d, calls } = deps({}, { legacy: sse })
    expect((await runMcpLogin('legacy', d)).ok).toBe(true)
    expect(calls.flows[0]![1]).toBe(sse)
  })

  test('an unknown server is refused before any flow', async () => {
    const { deps: d, calls } = deps()
    expect(await runMcpLogin('nope', d)).toEqual({
      ok: false,
      message: 'No MCP server named "nope". Run `claudin mcp list` to see the configured servers.',
    })
    expect(calls.flows).toHaveLength(0)
  })

  test('a local server is refused: it does not use OAuth', async () => {
    const { deps: d } = deps({}, { local: { command: 'npx', args: [], scope: 'local' } })
    expect(await runMcpLogin('local', d)).toEqual({
      ok: false,
      message: 'MCP server "local" is a stdio server; only http and sse servers sign in with OAuth.',
    })
    const { deps: d2 } = deps({}, { ws: { type: 'ws', url: 'wss://x', scope: 'user' } })
    expect((await runMcpLogin('ws', d2)).message).toContain('is a ws server')
  })

  test('a failed flow comes back with its reason', async () => {
    const { deps: d } = deps({
      performFlow: async () => {
        throw new Error('Authentication was cancelled')
      },
    })
    expect(await runMcpLogin('srv', d)).toEqual({
      ok: false,
      message: 'Authentication with "srv" failed: Authentication was cancelled',
    })
  })

  test('on a terminal, a pasted callback URL is submitted to the flow', async () => {
    const submitted: string[] = []
    const prompts: string[] = []
    const { deps: d } = deps({
      readLine: async prompt => {
        prompts.push(prompt)
        return '  http://localhost:4000/callback?code=abc&state=s  '
      },
      performFlow: async (_name, _config, onUrl, _signal, options) => {
        await new Promise<void>(resolve => {
          options?.onWaitingForCallback?.(url => {
            submitted.push(url)
            resolve()
          })
          onUrl('https://auth.example/authorize')
        })
      },
    })
    expect((await runMcpLogin('srv', d)).ok).toBe(true)
    expect(submitted).toEqual(['http://localhost:4000/callback?code=abc&state=s'])
    expect(prompts[0]).toContain('paste the URL')
  })

  test('the paste prompt waits for the URL, whichever the flow hands over first', async () => {
    const order: string[] = []
    const flow =
      (urlFirst: boolean): McpCliAuthDeps['performFlow'] =>
      async (_name, _config, onUrl, _signal, options) => {
        if (urlFirst) onUrl('https://auth.example/a')
        options?.onWaitingForCallback?.(() => {})
        if (!urlFirst) onUrl('https://auth.example/a')
        await Bun.sleep(5)
      }
    for (const urlFirst of [false, true]) {
      const { deps: d } = deps({
        performFlow: flow(urlFirst),
        readLine: async () => {
          order.push('prompt')
          return null
        },
        write: () => {
          order.push('url')
        },
      })
      await runMcpLogin('srv', d)
    }
    expect(order).toEqual(['url', 'prompt', 'url', 'prompt'])
  })

  test('a terminal read that fails is logged, not left unhandled', async () => {
    const { deps: d } = deps({
      performFlow: async (_name, _config, onUrl, _signal, options) => {
        options?.onWaitingForCallback?.(() => {})
        onUrl('https://auth.example/a')
        await Bun.sleep(5)
      },
      readLine: async () => {
        throw new Error('stdin closed')
      },
    })
    expect((await runMcpLogin('srv', d)).ok).toBe(true)
  })

  test('an empty line is not submitted, and without a terminal nothing is asked', async () => {
    const submitted: string[] = []
    const waiting = (readLine: McpCliAuthDeps['readLine']) =>
      deps({
        readLine,
        performFlow: async (_name, _config, _onUrl, _signal, options) => {
          options?.onWaitingForCallback?.(url => submitted.push(url))
          await Bun.sleep(10)
        },
      }).deps
    expect((await runMcpLogin('srv', waiting(async () => '   '))).ok).toBe(true)
    expect((await runMcpLogin('srv', waiting(async () => null))).ok).toBe(true)
    expect((await runMcpLogin('srv', waiting(null))).ok).toBe(true)
    expect(submitted).toEqual([])
  })
})

describe('runMcpLogout', () => {
  test('revokes and deletes the server’s tokens', async () => {
    const { deps: d, calls } = deps()
    const result = await runMcpLogout('srv', d)
    expect(result.ok).toBe(true)
    expect(result.message).toBe(
      'Signed out of "srv": its tokens were revoked where the server supports it and removed here.',
    )
    expect(calls.revoked).toEqual([['srv', httpServer]])
  })

  test('an unknown or local server is refused without touching any token', async () => {
    const { deps: d, calls } = deps({}, { local: { command: 'npx', args: [], scope: 'local' } })
    expect((await runMcpLogout('nope', d)).ok).toBe(false)
    expect((await runMcpLogout('local', d)).ok).toBe(false)
    expect(calls.revoked).toHaveLength(0)
  })
})
