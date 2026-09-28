import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  _resetH1OnlyForTesting,
  _resetKeepAliveForTesting,
  disableKeepAlive,
  getProviderDispatcher,
  getProxyFetchOptions,
  isProviderH1Only,
  markProviderH1Only,
  shouldBypassProxy,
} from 'src/providers/transport/proxy.js'

const originalProxyEnv = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
}

function clearProxyEnv(): void {
  delete process.env.HTTP_PROXY
  delete process.env.HTTPS_PROXY
  delete process.env.http_proxy
  delete process.env.https_proxy
}

function restoreProxyEnv(): void {
  for (const [k, v] of Object.entries(originalProxyEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  clearProxyEnv()
  _resetH1OnlyForTesting()
  _resetKeepAliveForTesting()
})

afterEach(() => {
  restoreProxyEnv()
  _resetH1OnlyForTesting()
  _resetKeepAliveForTesting()
})

test('getProviderDispatcher memoizes per provider', () => {
  const a1 = getProviderDispatcher('firstParty')
  const a2 = getProviderDispatcher('firstParty')
  const o1 = getProviderDispatcher('openai')
  expect(a1).toBe(a2)
  expect(a1).not.toBe(o1)
})

test('markProviderH1Only invalidates the cached dispatcher', () => {
  const before = getProviderDispatcher('openai')
  markProviderH1Only('openai')
  const after = getProviderDispatcher('openai')
  expect(after).not.toBe(before)
  expect(isProviderH1Only('openai')).toBe(true)
})

test('disableKeepAlive invalidates the cached dispatcher', () => {
  const before = getProviderDispatcher('deepseek')
  disableKeepAlive('deepseek')
  const after = getProviderDispatcher('deepseek')
  expect(after).not.toBe(before)
})

test('getProviderDispatcher returns distinct Agents for every canonical APIProvider value', () => {
  // Regression: profile-map keys must align with getAPIProvider() return
  // values. If a future rename drifts them apart, the per-provider tuning
  // silently falls back to the default profile.
  const canonical = [
    'firstParty',
    'openai',
    'gemini',
    'mistral',
    'github',
    'codex',
    'nvidia-nim',
    'minimax',
  ] as const
  const seen = new Set<unknown>()
  for (const p of canonical) {
    const d = getProviderDispatcher(p)
    expect(d).toBeDefined()
    seen.add(d)
  }
  expect(seen.size).toBe(canonical.length)
})

test('getProxyFetchOptions attaches a dispatcher when no proxy and provider is known', () => {
  const opts = getProxyFetchOptions({ provider: 'firstParty' })
  expect(opts.dispatcher).toBeDefined()
})

test('getProxyFetchOptions returns no dispatcher when no proxy and no provider', () => {
  const opts = getProxyFetchOptions()
  expect(opts.dispatcher).toBeUndefined()
})

test('getProxyFetchOptions defers to proxy path when HTTPS_PROXY is set', () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:65535'
  const opts = getProxyFetchOptions({ provider: 'firstParty' }) as {
    dispatcher?: unknown
    proxy?: string
  }
  // Under Bun: returns { proxy } string. Under Node: returns { dispatcher }
  // backed by EnvHttpProxyAgent. Either way, the per-provider Agent must NOT
  // be the dispatcher attached to this options object (proxy takes precedence).
  const usingBun = typeof Bun !== 'undefined'
  if (usingBun) {
    expect(opts.proxy).toBe('http://127.0.0.1:65535')
  } else {
    expect(opts.dispatcher).toBeDefined()
    expect(opts.dispatcher).not.toBe(getProviderDispatcher('firstParty'))
  }
})

// The axios path (hooks, OAuth) decides with shouldBypassProxy while fetch goes
// through undici's EnvHttpProxyAgent, so the two must agree on every NO_PROXY
// value. These rows are undici 8.11's semantics.
describe('shouldBypassProxy matches undici EnvHttpProxyAgent', () => {
  const cases: [noProxy: string, url: string, bypass: boolean][] = [
    ['', 'https://example.com', false],
    ['*', 'https://example.com', true],
    ['localhost,*', 'https://example.com', true],
    [' * ', 'https://example.com', true],
    ['*:8080', 'http://example.com:8080', true],
    ['*:8080', 'https://example.com', false],
    ['example.com', 'https://example.com', true],
    ['example.com', 'https://api.example.com', true],
    ['example.com', 'https://notexample.com', false],
    ['.example.com', 'https://example.com', true],
    ['.example.com', 'https://api.example.com', true],
    ['*.example.com', 'https://api.example.com', true],
    ['*.example.com', 'https://example.com', false],
    ['example.com.', 'https://api.example.com', true],
    ['EXAMPLE.com', 'https://Api.Example.COM', true],
    ['example.com:8080', 'http://example.com:8080', true],
    ['example.com:8080', 'http://api.example.com:8080', true],
    ['example.com:8080', 'https://example.com', false],
    ['example.com:443', 'https://example.com', true],
    ['example.com:80', 'ws://example.com', true],
    ['127.0.0.1', 'http://127.0.0.1:3000', true],
    ['::1', 'http://[::1]:3000', true],
    ['[::1]:3000', 'http://[::1]:3000', true],
    ['[::1]:3000', 'http://[::1]:4000', false],
    ['localhost', 'not a url', false],
  ]

  for (const [noProxy, url, bypass] of cases) {
    test(`NO_PROXY=${JSON.stringify(noProxy)} ${url} → ${bypass ? 'direct' : 'proxy'}`, () => {
      expect(shouldBypassProxy(url, noProxy)).toBe(bypass)
    })
  }
})
