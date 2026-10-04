/**
 * The mcp/auth fixes outside headersHelper: a timeout on every revocation
 * request (Finding 8) and a pasted client secret read as typed (Finding 12),
 * plus the client-authentication choice on its own.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearMcpClientConfig,
  clearServerTokensFromSecureStorage,
  getServerKey,
  readClientSecret,
  revokeServerTokens,
  saveMcpClientSecret,
} from 'src/mcp/auth.js'
import { createTimedAuthFetch, fetchAuthServerMetadata, OAUTH_REQUEST_TIMEOUT_MS } from 'src/mcp/auth/authFetch.js'
import { applyTerminalInput } from 'src/mcp/auth/hiddenPrompt.js'
import {
  applyClientAuth,
  basicCredentials,
  chooseClientAuth,
  type RevocationClientAuth,
} from 'src/mcp/auth/revocation/clientAuth.js'
import { DEFAULT_REVOCATION_DEPS, signOutServer } from 'src/mcp/auth/revocation/signOut.js'
import { type AuthBed, startAuthBed, useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import type { McpHTTPServerConfig } from 'src/mcp/types.js'

const store = useIsolatedStore()

describe('Finding 8: revocation requests have a deadline', () => {
  let bed: AuthBed | undefined
  let silent: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => {
    bed?.stop()
    silent?.stop(true)
  })

  test('a revocation endpoint that never answers is given up on, and the local tokens are still cleared', async () => {
    const pending: string[] = []
    silent = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: req => {
        pending.push(new URL(req.url).pathname)
        return new Promise<Response>(() => {})
      },
    })
    bed = startAuthBed({ metadataExtra: { revocation_endpoint: `http://127.0.0.1:${silent.port}/revoke` } })
    const cfg: McpHTTPServerConfig = { type: 'http', url: bed.mcpUrl }
    const key = getServerKey('docs', cfg)
    store.write({ mcpOAuth: { [key]: { serverName: 'docs', serverUrl: cfg.url, accessToken: 'at', refreshToken: 'rt', expiresAt: 1 } } })

    const started = Date.now()
    await signOutServer('docs', cfg, false, { requestTimeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(pending).toEqual(['/revoke', '/revoke'])
    expect(store.read()!.mcpOAuth[key]).toBeUndefined()
  })

  test('the timed fetch aborts at its deadline, and sign-out uses the OAuth request timeout', async () => {
    silent = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) })
    const started = Date.now()
    await expect(createTimedAuthFetch(200)(`http://127.0.0.1:${silent.port}/`, { method: 'POST' })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1500)
    expect(DEFAULT_REVOCATION_DEPS.requestTimeoutMs).toBe(OAUTH_REQUEST_TIMEOUT_MS)
    expect(OAUTH_REQUEST_TIMEOUT_MS).toBe(30_000)
  })
})

describe('Finding 12: terminal input is read character by character', () => {
  test('applyTerminalInput', () => {
    type Case = [label: string, before: string, chunk: string, out: ReturnType<typeof applyTerminalInput>]
    const cases: Case[] = [
      ['typed key', 'ab', 'c', { status: 'typing', text: 'abc' }],
      ['paste without Enter', '', 'pasted', { status: 'typing', text: 'pasted' }],
      ['paste ending in CR', '', 'pasted\r', { status: 'entered', text: 'pasted' }],
      ['paste ending in LF', 'x', 'yz\n', { status: 'entered', text: 'xyz' }],
      ['CRLF', '', 'abc\r\n', { status: 'entered', text: 'abc' }],
      ['anything after Enter is dropped', '', 'abc\rdef', { status: 'entered', text: 'abc' }],
      ['DEL inside a chunk', '', 'ab\u007Fc', { status: 'typing', text: 'ac' }],
      ['BS inside a chunk', 'q', 'x\by\r', { status: 'entered', text: 'qy' }],
      ['backspace on nothing', '', '\u007F\u007Fa', { status: 'typing', text: 'a' }],
      ['backspace removes a whole code point', 'k🔑', '\u007F', { status: 'typing', text: 'k' }],
      ['Ctrl+C inside a chunk', 'abc', 'd\u0003e\r', { status: 'cancelled' }],
      ['Enter alone', '', '\r', { status: 'entered', text: '' }],
    ]
    for (const [label, before, chunk, out] of cases) expect(applyTerminalInput(before, chunk), label).toEqual(out)
  })

})

/** A prompt that never settles must fail its test, not stall the runner. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)),
  ])
}

describe('at a TTY', () => {
  // Every global this touches is put back in afterEach, which runs even when
  // a test times out.
  const saved: Record<string, PropertyDescriptor | undefined> = {}
  let realWrite: typeof process.stderr.write
  let listenersBefore: ((...args: unknown[]) => void)[] = []
  const raw: boolean[] = []
  const written: string[] = []

  beforeEach(() => {
    for (const name of ['isTTY', 'setRawMode']) saved[name] = Object.getOwnPropertyDescriptor(process.stdin, name)
    listenersBefore = process.stdin.listeners('data') as typeof listenersBefore
    raw.length = 0
    written.length = 0
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true })
    Object.defineProperty(process.stdin, 'setRawMode', {
      value: (on: boolean) => {
        raw.push(on)
        return process.stdin
      },
      configurable: true,
      writable: true,
    })
    realWrite = process.stderr.write
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
  })

  afterEach(() => {
    process.stderr.write = realWrite
    for (const listener of process.stdin.listeners('data')) {
      if (!listenersBefore.includes(listener as (typeof listenersBefore)[number])) {
        process.stdin.removeListener('data', listener as (...args: unknown[]) => void)
      }
    }
    for (const name of ['isTTY', 'setRawMode']) {
      const descriptor = saved[name]
      if (descriptor) Object.defineProperty(process.stdin, name, descriptor)
      else delete (process.stdin as unknown as Record<string, unknown>)[name]
    }
    process.stdin.pause()
  })

  test('Finding 12: a pasted secret ending in Enter resolves at once, with no control character in it', async () => {
      const cases: [chunks: string[], secret: string][] = [
        [['s3cr3t-value\r'], 's3cr3t-value'],
        [['s3cr', 't\u007F3t\n'], 's3cr3t'],
        [['abc\r\n'], 'abc'],
      ]
      for (const [chunks, secret] of cases) {
        const listeners = process.stdin.listenerCount('data')
        const reading = readClientSecret()
        for (const chunk of chunks) process.stdin.emit('data', Buffer.from(chunk))
        expect(await within(reading)).toBe(secret)
        expect(process.stdin.listenerCount('data')).toBe(listeners)
      }
  })

  test('Ctrl+C inside a pasted chunk cancels', async () => {
    const reading = readClientSecret()
    process.stdin.emit('data', Buffer.from('abc\u0003def\r'))
    await expect(within(reading)).rejects.toThrow('Cancelled')
  })

  test('it asks on stderr, in raw mode, and leaves raw mode on either ending', async () => {
    const done = readClientSecret()
    expect(raw).toEqual([true])
    process.stdin.emit('data', Buffer.from('k\r'))
    expect(await within(done)).toBe('k')
    const cancelled = readClientSecret()
    process.stdin.emit('data', Buffer.from('\u0003'))
    await expect(within(cancelled)).rejects.toThrow('Cancelled')
    expect(raw).toEqual([true, false, true, false])
    expect(written).toEqual(['Enter OAuth client secret: ', '\n', 'Enter OAuth client secret: '])
  })

  test('without a TTY nothing is asked and stdin is left alone', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true })
    const listeners = process.stdin.listenerCount('data')
    await expect(within(readClientSecret())).rejects.toThrow('No TTY available')
    expect([raw, written, process.stdin.listenerCount('data')]).toEqual([[], [], listeners])
  })
})

describe('the store and discovery, beyond the characterization suite', () => {
  const beds: AuthBed[] = []
  afterEach(() => {
    for (const b of beds.splice(0)) b.stop()
  })
  const bedWith = (overrides: Parameters<typeof startAuthBed>[0] = {}) => {
    const b = startAuthBed(overrides)
    beds.push(b)
    return b
  }
  const vaultWrites = () => store.vaultCalls().filter(c => c.startsWith('store ')).length

  test('keeping the step-up state leaves every other server and map as it was', async () => {
    const b = bedWith({ metadataExtra: { revocation_endpoint: undefined } })
    const cfg: McpHTTPServerConfig = { type: 'http', url: b.mcpUrl }
    const neighbour = { serverName: 'n', serverUrl: 'https://n.test/mcp', accessToken: 'keep', expiresAt: 1 }
    store.write({
      mcpOAuth: { other: neighbour, [getServerKey('docs', cfg)]: { serverName: 'docs', serverUrl: cfg.url, accessToken: 'at', expiresAt: 1, stepUpScope: 'admin' } },
      mcpOAuthClientConfig: { other: { clientSecret: 's' } },
    })
    await signOutServer('docs', cfg, true, DEFAULT_REVOCATION_DEPS)
    expect(store.read()).toEqual({
      mcpOAuth: { other: neighbour, [getServerKey('docs', cfg)]: { serverName: 'docs', serverUrl: cfg.url, accessToken: '', expiresAt: 0, stepUpScope: 'admin' } },
      mcpOAuthClientConfig: { other: { clientSecret: 's' } },
    })
  })

  test('clearing a client secret leaves the token map as it was', () => {
    const cfg: McpHTTPServerConfig = { type: 'http', url: 'https://mcp.test/mcp' }
    const tokens = { [getServerKey('docs', cfg)]: { serverName: 'docs', serverUrl: cfg.url, accessToken: 'a', expiresAt: 1 } }
    store.write({ mcpOAuth: tokens, mcpOAuthClientConfig: { [getServerKey('docs', cfg)]: { clientSecret: 's' }, other: { clientSecret: 'o' } } })
    clearMcpClientConfig('docs', cfg)
    expect(store.read()).toEqual({ mcpOAuth: tokens, mcpOAuthClientConfig: { other: { clientSecret: 'o' } } })
  })

  test('clearing what is not stored writes nothing to the store', () => {
    const cfg: McpHTTPServerConfig = { type: 'http', url: 'https://mcp.test/mcp' }
    store.write({ mcpOAuth: { other: { accessToken: 'a' } }, mcpOAuthClientConfig: { other: { clientSecret: 's' } } })
    const before = vaultWrites()
    clearServerTokensFromSecureStorage('docs', cfg)
    clearMcpClientConfig('docs', cfg)
    expect(vaultWrites()).toBe(before)
    saveMcpClientSecret('docs', cfg, 's2')
    expect(vaultWrites()).toBeGreaterThan(before)
  })

  test('a configured metadata URL goes through the given fetch, asking for JSON', async () => {
    const calls: { url: string; accept: string | null }[] = []
    const fake = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), accept: new Headers(init?.headers).get('accept') })
      return Response.json({ issuer: 'https://as.test', authorization_endpoint: 'https://as.test/a', token_endpoint: 'https://as.test/t', response_types_supported: ['code'] })
    }
    const metadata = await fetchAuthServerMetadata('docs', 'https://mcp.test/mcp', 'https://as.test/meta', fake)
    expect(metadata?.token_endpoint).toBe('https://as.test/t')
    expect(calls).toEqual([{ url: 'https://as.test/meta', accept: 'application/json' }])
  })

  test('a root server URL gets no second, path-aware attempt', async () => {
    const b = bedWith({ protectedResource: false, metadataAt: 'nowhere' })
    expect(await fetchAuthServerMetadata('docs', `${b.base}/`, undefined)).toBeUndefined()
    expect(b.hits('/.well-known/oauth-authorization-server')).toHaveLength(1)
  })

  test('sign-out honours the configured metadata URL, so an http one stops it before any request', async () => {
    const b = bedWith()
    const cfg: McpHTTPServerConfig = { type: 'http', url: b.mcpUrl, oauth: { authServerMetadataUrl: 'http://as.test/metadata' } }
    store.write({ mcpOAuth: { [getServerKey('docs', cfg)]: { serverName: 'docs', serverUrl: cfg.url, accessToken: 'at', expiresAt: 1 } } })
    await revokeServerTokens('docs', cfg)
    expect(b.seen).toHaveLength(0)
    expect(store.read()!.mcpOAuth).toEqual({})
  })
})

describe('client authentication for revocation', () => {
  test('chooseClientAuth', () => {
    const both = { clientId: 'id', clientSecret: 'sec' }
    type Case = [label: string, client: { clientId?: string; clientSecret?: string }, meta: Record<string, string[]>, kind: RevocationClientAuth['kind']]
    const cases: Case[] = [
      ['nothing stored', {}, {}, 'none'],
      ['secret without id', { clientSecret: 'sec' }, {}, 'none'],
      ['id only', { clientId: 'id' }, { revocation_endpoint_auth_methods_supported: ['client_secret_basic'] }, 'public'],
      ['no list', both, {}, 'basic'],
      ['empty list', both, { revocation_endpoint_auth_methods_supported: [] }, 'basic'],
      ['post only', both, { revocation_endpoint_auth_methods_supported: ['client_secret_post'] }, 'post'],
      ['both', both, { revocation_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] }, 'basic'],
      ['token list as fallback', both, { token_endpoint_auth_methods_supported: ['client_secret_post'] }, 'post'],
      ['revocation list first', both, { revocation_endpoint_auth_methods_supported: ['client_secret_basic'], token_endpoint_auth_methods_supported: ['client_secret_post'] }, 'basic'],
      ['neither method', both, { revocation_endpoint_auth_methods_supported: ['private_key_jwt'] }, 'basic'],
    ]
    for (const [label, client, meta, kind] of cases) expect(chooseClientAuth(client, meta).kind, label).toBe(kind)
  })

  test('applyClientAuth puts one form of credentials in one place', () => {
    const run = (auth: Parameters<typeof applyClientAuth>[0]) => {
      const headers: Record<string, string> = {}
      const form = new URLSearchParams({ token: 't' })
      applyClientAuth(auth, headers, form)
      return { headers, form: Object.fromEntries(form) }
    }
    expect(run({ kind: 'basic', clientId: 'a b', clientSecret: 'p@ss:x' })).toEqual({
      headers: { Authorization: basicCredentials('a b', 'p@ss:x') },
      form: { token: 't' },
    })
    expect(basicCredentials('a b', 'p@ss:x')).toBe(`Basic ${btoa('a%20b:p%40ss%3Ax')}`)
    expect(run({ kind: 'post', clientId: 'a', clientSecret: 's' })).toEqual({ headers: {}, form: { token: 't', client_id: 'a', client_secret: 's' } })
    expect(run({ kind: 'public', clientId: 'a' })).toEqual({ headers: {}, form: { token: 't', client_id: 'a' } })
    expect(run({ kind: 'none' })).toEqual({ headers: {}, form: { token: 't' } })
  })
})
