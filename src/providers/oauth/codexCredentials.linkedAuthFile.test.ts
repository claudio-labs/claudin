import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GlobalConfig, ProviderProfile } from 'src/platform/config/config.js'
import { DEFAULT_CODEX_BASE_URL } from 'src/providers/presets/providerConfig.js'

// A profile linked to a Codex CLI auth.json is served from that file, so a
// refresh must land there and never in secure storage, which would rotate a
// second, unrelated token family.

let activeProfile: ProviderProfile | null = null
const realConfig = { ...(await import('src/platform/config/config.js')) }
const realProviderProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }
const realSecureStorage = { ...(await import('src/platform/secureStorage/index.js')) }

mock.module('src/platform/config/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    providerProfiles: activeProfile ? [activeProfile] : [],
    activeProviderProfileId: activeProfile?.id,
  } as unknown as GlobalConfig),
}))
mock.module('src/providers/presets/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => activeProfile ?? undefined,
}))

afterAll(() => {
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/providers/presets/providerProfiles.js', () => realProviderProfiles)
  mock.module('src/platform/secureStorage/index.js', () => realSecureStorage)
})

const { invalidateActiveProviderCache } = await import(
  'src/providers/presets/activeProvider.js'
)

const originalFetch = globalThis.fetch
const originalSimple = process.env.CLAUDIN_SIMPLE
const tempDirs: string[] = []

afterEach(() => {
  globalThis.fetch = originalFetch
  activeProfile = null
  invalidateActiveProviderCache()
  if (originalSimple === undefined) {
    delete process.env.CLAUDIN_SIMPLE
  } else {
    process.env.CLAUDIN_SIMPLE = originalSimple
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

function expiredJwt(): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const body = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() - 60_000) / 1000) }),
  ).toString('base64url')
  return `${header}.${body}.signature`
}

test('a linked profile refreshes its auth.json and never touches secure storage', async () => {
  delete process.env.CLAUDIN_SIMPLE

  const dir = mkdtempSync(join(tmpdir(), 'claudin-codex-linked-'))
  tempDirs.push(dir)
  const authPath = join(dir, 'auth.json')
  writeFileSync(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: expiredJwt(),
        refresh_token: 'refresh-old',
        account_id: 'acct_cli',
      },
    }),
    'utf8',
  )

  activeProfile = {
    id: 'provider_codex_cli',
    name: 'Codex OAuth',
    provider: 'openai',
    baseUrl: DEFAULT_CODEX_BASE_URL,
    model: 'codexplan',
    extras: { codexAuthPath: authPath },
  } as ProviderProfile
  invalidateActiveProviderCache()

  const storageTouched = mock(() => {
    throw new Error('secure storage must not be read for a linked profile')
  })
  mock.module('src/platform/secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      read: storageTouched,
      readAsync: storageTouched,
      update: storageTouched,
    }),
  }))

  const fetchMock = mock(async () =>
    Response.json({ access_token: 'access-new', refresh_token: 'refresh-new' }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const { refreshCodexAccessTokenIfNeeded } = await import(
    // @ts-expect-error cache-busting query string for Bun module mocks
    './codexCredentials.js?linked-auth-file'
  )

  expect(await refreshCodexAccessTokenIfNeeded()).toEqual({ refreshed: true })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(storageTouched).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(authPath, 'utf8')).tokens).toMatchObject({
    access_token: 'access-new',
    refresh_token: 'refresh-new',
    account_id: 'acct_cli',
  })
})
