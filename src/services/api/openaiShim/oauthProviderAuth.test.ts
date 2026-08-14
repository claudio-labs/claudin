import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

import type { ResolvedProvider } from 'src/services/api/activeProvider.js'
import {
  invalidateKimiCredentialCache,
  saveKimiCredentials,
} from 'src/utils/kimiCredentials.js'
import { getKimiUserAgent } from 'src/utils/kimiUserAgent.js'
import { saveXaiCredentials } from 'src/utils/xaiCredentials.js'
import { getXaiUserAgent } from 'src/utils/xaiUserAgent.js'
import {
  forceRefreshOAuthWebTokenOn401,
  resolveOAuthProviderAuth,
} from './oauthProviderAuth.js'

// This suite drives real credential round-trips (saveKimi/saveXai → resolve),
// so it needs a working secure storage. Many sibling test files mock.module
// secureStorage and Bun applies those overrides for the whole run, so relying
// on the real fs-backed store makes us a non-deterministic victim. Instead we
// own an in-memory store, re-applied in beforeEach so no earlier file's mock
// can shadow it, and restored in afterAll so we don't leak it onward.
const realSecureStorage = {
  ...(await import('src/utils/secureStorage/index.js')),
}
let storageState: Record<string, unknown> = {}

function mockSecureStorage() {
  const factory = () => ({
    ...realSecureStorage,
    getSecureStorage: () => ({
      name: 'mock-secure-storage',
      read: () => storageState,
      readAsync: async () => storageState,
      update: (next: Record<string, unknown>) => {
        storageState = next
        return { success: true }
      },
      delete: () => {
        storageState = {}
        return true
      },
    }),
  })
  mock.module('src/utils/secureStorage/index.js', factory)
  mock.module('src/utils/secureStorage/index.js', factory)
}

const originalSimple = process.env.CLAUDE_CODE_SIMPLE
const originalArgv = [...process.argv]

beforeEach(() => {
  // A sibling test may leak bare mode (CLAUDE_CODE_SIMPLE truthy or --bare in
  // argv), which makes saveKimi/saveXaiCredentials short-circuit to {success:
  // false} before touching storage — so clear it, else every save no-ops here.
  delete process.env.CLAUDE_CODE_SIMPLE
  process.argv = originalArgv.filter(arg => arg !== '--bare')
  storageState = {}
  mockSecureStorage()
  // Module-level Kimi credential cache — reset so a stored blob isn't shadowed
  // by one cached in a previous test (TTL is 30s).
  invalidateKimiCredentialCache()
})

afterEach(() => {
  process.argv = originalArgv
  if (originalSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = originalSimple
})

afterAll(() => {
  mock.module('src/utils/secureStorage/index.js', () => realSecureStorage)
  mock.module('src/utils/secureStorage/index.js', () => realSecureStorage)
})

function profile(overrides: Partial<ResolvedProvider>): ResolvedProvider {
  return {
    transport: overrides.transport ?? 'openai_compat',
    baseUrl: overrides.baseUrl ?? 'https://api.openai.com/v1',
    model: overrides.model ?? 'gpt-5.4',
    apiKey: overrides.apiKey,
    extras: overrides.extras,
    name: overrides.name ?? 'Test',
  }
}

const future = () => Date.now() + 900_000

test('xAI OAuth profile → OAuth token + xAI UA, no device headers', async () => {
  saveXaiCredentials({
    accessToken: 'xai-tok',
    refreshToken: 'xai-ref',
    expiresAt: future(),
  })
  const auth = await resolveOAuthProviderAuth(
    profile({ baseUrl: 'https://api.x.ai/v1' }),
  )
  expect(auth.accessToken).toBe('xai-tok')
  expect(auth.userAgent).toBe(getXaiUserAgent())
  expect(auth.deviceHeaders).toBeUndefined()
})

test('xAI OAuth host with no stored token → empty auth (no UA without a token)', async () => {
  const auth = await resolveOAuthProviderAuth(
    profile({ baseUrl: 'https://api.x.ai/v1' }),
  )
  expect(auth).toEqual({})
})

test('xAI host with a static apiKey → empty auth (no OAuth swap, no UA)', async () => {
  const auth = await resolveOAuthProviderAuth(
    profile({ baseUrl: 'https://api.x.ai/v1', apiKey: 'sk-static' }),
  )
  expect(auth).toEqual({})
})

test('Kimi OAuth profile → OAuth token + Kimi UA + X-Msh-* device headers', async () => {
  saveKimiCredentials({
    accessToken: 'kimi-tok',
    refreshToken: 'kimi-ref',
    expiresAt: future(),
  })
  const auth = await resolveOAuthProviderAuth(
    profile({ baseUrl: 'https://api.kimi.com/coding/v1' }),
  )
  expect(auth.accessToken).toBe('kimi-tok')
  expect(auth.userAgent).toBe(getKimiUserAgent())
  expect(auth.deviceHeaders?.['X-Msh-Platform']).toBe('kimi_code_cli')
  expect(auth.deviceHeaders?.['X-Msh-Device-Id']).toBeTruthy()
})

test('Kimi coding host with a static apiKey → UA + device headers but NO token swap', async () => {
  // Guards the recent fix: X-Msh-* headers must be attached for a static-key
  // Kimi coding profile even though no OAuth token is swapped in.
  const auth = await resolveOAuthProviderAuth(
    profile({ baseUrl: 'https://api.kimi.com/coding/v1', apiKey: 'sk-static' }),
  )
  expect(auth.accessToken).toBeUndefined()
  expect(auth.userAgent).toBe(getKimiUserAgent())
  expect(auth.deviceHeaders?.['X-Msh-Platform']).toBe('kimi_code_cli')
})

test('Kimi OAuth: a throwing preflight refresh falls back to the stored token', async () => {
  // Guards the .catch resilience path in resolveOAuthProviderAuth — a failed
  // refresh must reuse the stored (stale) credentials, not drop the request.
  saveKimiCredentials({
    accessToken: 'kimi-stale',
    refreshToken: 'ref',
    expiresAt: Date.now() - 1_000, // expired → triggers a refresh attempt
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => {
    throw new Error('network down')
  }) as unknown as typeof fetch
  try {
    const auth = await resolveOAuthProviderAuth(
      profile({ baseUrl: 'https://api.kimi.com/coding/v1' }),
    )
    expect(auth.accessToken).toBe('kimi-stale')
    expect(auth.userAgent).toBe(getKimiUserAgent())
    expect(auth.deviceHeaders?.['X-Msh-Platform']).toBe('kimi_code_cli')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('plain openai_compat profile → empty auth', async () => {
  const auth = await resolveOAuthProviderAuth(
    profile({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-openai' }),
  )
  expect(auth).toEqual({})
})

test('null profile → empty auth', async () => {
  expect(await resolveOAuthProviderAuth(null)).toEqual({})
})

// forceRefreshOAuthWebTokenOn401 dispatches by base URL: it returns 'refreshed'
// when an OAuth-web provider matches (xAI / Kimi coding host) and the refresh
// succeeds, and 'no-match' otherwise. With no stored credentials the underlying
// refresh is a no-op (succeeds trivially), so these assert the registry's match
// wiring, not a live token exchange.
test.each([
  ['https://api.x.ai/v1'],
  ['https://api.kimi.com/coding/v1'],
])('forceRefreshOAuthWebTokenOn401: %s matches an OAuth-web provider', async baseUrl => {
  expect(await forceRefreshOAuthWebTokenOn401(baseUrl)).toBe('refreshed')
})

test.each([
  ['https://api.openai.com/v1'],
  ['https://api.deepseek.com/v1'],
])('forceRefreshOAuthWebTokenOn401: %s does not match', async baseUrl => {
  expect(await forceRefreshOAuthWebTokenOn401(baseUrl)).toBe('no-match')
})

test('forceRefreshOAuthWebTokenOn401: undefined base URL → no-match', async () => {
  expect(await forceRefreshOAuthWebTokenOn401(undefined)).toBe('no-match')
})

test('forceRefreshOAuthWebTokenOn401: refresh throws → failed', async () => {
  // Guards the withRetry short-circuit: a dead refresh token must surface as
  // 'failed', not swallow the error and report success.
  saveKimiCredentials({
    accessToken: 'kimi-stale',
    refreshToken: 'ref',
    expiresAt: Date.now() - 1_000,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => {
    throw new Error('network down')
  }) as unknown as typeof fetch
  try {
    expect(
      await forceRefreshOAuthWebTokenOn401('https://api.kimi.com/coding/v1'),
    ).toBe('failed')
  } finally {
    globalThis.fetch = originalFetch
  }
})
