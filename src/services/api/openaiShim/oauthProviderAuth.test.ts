import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ResolvedProvider } from '../activeProvider.js'
import {
  invalidateKimiCredentialCache,
  saveKimiCredentials,
} from '../../../utils/kimiCredentials.js'
import { getKimiUserAgent } from '../../../utils/kimiUserAgent.js'
import { saveXaiCredentials } from '../../../utils/xaiCredentials.js'
import { getXaiUserAgent } from '../../../utils/xaiUserAgent.js'
import {
  forceRefreshOAuthWebTokenOn401,
  resolveOAuthProviderAuth,
} from './oauthProviderAuth.js'

const originalConfigDir = process.env.CLAUDIN_CONFIG_DIR

beforeEach(() => {
  process.env.CLAUDIN_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'oauth-auth-'))
  // Module-level Kimi credential cache — reset so a throwaway dir isn't shadowed
  // by a blob cached in a previous test (TTL is 30s).
  invalidateKimiCredentialCache()
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = originalConfigDir
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

// forceRefreshOAuthWebTokenOn401 dispatches by base URL: it returns true when an
// OAuth-web provider matches (xAI / Kimi coding host) and false otherwise. With
// no stored credentials the underlying refresh is a no-op, so these assert the
// registry's match wiring, not a live token exchange.
test.each([
  ['https://api.x.ai/v1'],
  ['https://api.kimi.com/coding/v1'],
])('forceRefreshOAuthWebTokenOn401: %s matches an OAuth-web provider', async baseUrl => {
  expect(await forceRefreshOAuthWebTokenOn401(baseUrl)).toBe(true)
})

test.each([
  ['https://api.openai.com/v1'],
  ['https://api.deepseek.com/v1'],
])('forceRefreshOAuthWebTokenOn401: %s does not match', async baseUrl => {
  expect(await forceRefreshOAuthWebTokenOn401(baseUrl)).toBe(false)
})

test('forceRefreshOAuthWebTokenOn401: undefined base URL → false', async () => {
  expect(await forceRefreshOAuthWebTokenOn401(undefined)).toBe(false)
})
