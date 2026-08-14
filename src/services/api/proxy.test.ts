import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  _resetH1OnlyForTesting,
  _resetKeepAliveForTesting,
  disableKeepAlive,
  getProviderDispatcher,
  getProxyFetchOptions,
  isProviderH1Only,
  markProviderH1Only,
} from './proxy.js'

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
