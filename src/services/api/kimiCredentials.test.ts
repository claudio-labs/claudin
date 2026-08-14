import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// This file used to run against whatever backend getSecureStorage() picked for
// the machine, which left it a hostage to both the environment and the rest of
// the run. With libsecret present it went to the keyring; without it (CI) it
// fell through to plainTextStorage, which WRITES through slowOperations but
// READS through getFsImplementation() — so any earlier file leaving a partial fs
// implementation behind turns a successful write into an unreadable read, and
// every assertion here fails with `undefined` while `update` still reports
// success. The subject is the cache/refresh/JWT logic, not the platform vault,
// so pin an in-memory backend the way every sibling credential test does.
const realSecureStorage = {
  ...(await import('src/services/secureStorage/index.js')),
}

let storageState: Record<string, unknown> = {}

mock.module('src/services/secureStorage/index.js', () => ({
  ...realSecureStorage,
  getSecureStorage: () => ({
    name: 'in-memory-secure-storage',
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
}))

// Imported AFTER the mock so the module under test closes over the fake.
const {
  clearKimiCredentials,
  invalidateKimiCredentialCache,
  readKimiCredentials,
  readKimiCredentialsAsync,
  refreshKimiAccessTokenIfNeeded,
  saveKimiCredentials,
} = await import('./kimiCredentials.js')

const originalFetch = globalThis.fetch

beforeEach(() => {
  storageState = {}
  // The credential cache is module-level; reset it so a fresh store isn't
  // shadowed by a blob cached in a previous test (TTL is 30s).
  invalidateKimiCredentialCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// mock.restore() does not revert mock.module(), and Bun applies the override for
// the whole run — hand the real module back so no later file inherits this fake.
afterAll(() => {
  mock.module('src/services/secureStorage/index.js', () => realSecureStorage)
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Minimal unsigned JWT (`header.payload.sig`) so parseJwtExpiryMs can decode exp.
function fakeJwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`
}

test('save + read round-trips the blob', () => {
  const saved = saveKimiCredentials({
    accessToken: 'acc-1',
    refreshToken: 'ref-1',
    expiresAt: Date.now() + 900_000,
    profileId: 'p-1',
  })
  expect(saved.success).toBe(true)
  const read = readKimiCredentials()
  expect(read?.accessToken).toBe('acc-1')
  expect(read?.refreshToken).toBe('ref-1')
  expect(read?.profileId).toBe('p-1')
})

test('clear removes the blob', () => {
  saveKimiCredentials({ accessToken: 'acc-1', refreshToken: 'ref-1' })
  expect(clearKimiCredentials().success).toBe(true)
  expect(readKimiCredentials()).toBeUndefined()
})

test('refresh is a no-op when nothing is stored', async () => {
  const result = await refreshKimiAccessTokenIfNeeded()
  expect(result.refreshed).toBe(false)
  expect(result.credentials).toBeUndefined()
})

test('refresh does not fire when the token is still fresh', async () => {
  saveKimiCredentials({
    accessToken: 'acc-fresh',
    refreshToken: 'ref-1',
    expiresAt: Date.now() + 900_000,
  })
  const result = await refreshKimiAccessTokenIfNeeded()
  expect(result.refreshed).toBe(false)
  expect(result.credentials?.accessToken).toBe('acc-fresh')
})

test('refresh derives expiry from the JWT when expiresAt is absent (future exp → no refresh)', async () => {
  // No expiresAt stored → shouldRefreshKimiToken falls back to parseJwtExpiryMs.
  const jwt = fakeJwt({ exp: Math.floor((Date.now() + 900_000) / 1000) })
  saveKimiCredentials({ accessToken: jwt, refreshToken: 'ref-1' })
  // fetch left real: a correct future-exp read makes no network call. A regression
  // that decided to refresh would attempt fetch and fail the assertion.
  const result = await refreshKimiAccessTokenIfNeeded()
  expect(result.refreshed).toBe(false)
  expect(result.credentials?.accessToken).toBe(jwt)
})

test('refresh does not fire for an opaque (non-JWT) token with no expiresAt', async () => {
  // parseJwtExpiryMs returns undefined → shouldRefreshKimiToken returns false.
  saveKimiCredentials({ accessToken: 'opaque-token', refreshToken: 'ref-1' })
  const result = await refreshKimiAccessTokenIfNeeded()
  expect(result.refreshed).toBe(false)
  expect(result.credentials?.accessToken).toBe('opaque-token')
})

test('readAsync caches within the TTL and re-reads after invalidation', async () => {
  saveKimiCredentials({
    accessToken: 'acc-1',
    refreshToken: 'ref-1',
    expiresAt: Date.now() + 900_000,
  })
  // First async read populates the in-process cache.
  expect((await readKimiCredentialsAsync())?.accessToken).toBe('acc-1')

  // Mutate storage out-of-band (bypassing saveKimiCredentials, so the cache is
  // NOT invalidated). A cached read must not observe it within the TTL.
  storageState = {
    ...storageState,
    kimiCode: {
      accessToken: 'acc-2',
      refreshToken: 'ref-2',
      expiresAt: Date.now() + 900_000,
    },
  }
  expect((await readKimiCredentialsAsync())?.accessToken).toBe('acc-1')

  // After an explicit invalidation the next read reflects storage.
  invalidateKimiCredentialCache()
  expect((await readKimiCredentialsAsync())?.accessToken).toBe('acc-2')
})

test('saveKimiCredentials invalidates the cache so the next read is fresh', async () => {
  saveKimiCredentials({
    accessToken: 'acc-1',
    refreshToken: 'ref-1',
    expiresAt: Date.now() + 900_000,
  })
  expect((await readKimiCredentialsAsync())?.accessToken).toBe('acc-1')
  saveKimiCredentials({
    accessToken: 'acc-2',
    refreshToken: 'ref-1',
    expiresAt: Date.now() + 900_000,
  })
  expect((await readKimiCredentialsAsync())?.accessToken).toBe('acc-2')
})

test('refresh rotates the token, persists it, and updates expiry', async () => {
  saveKimiCredentials({
    accessToken: 'acc-old',
    refreshToken: 'ref-old',
    expiresAt: Date.now() - 1_000, // already expired → should refresh
  })
  const fetchMock = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://auth.kimi.com/api/oauth/token')
      const body = new URLSearchParams(String(init?.body ?? ''))
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('ref-old')
      return jsonResponse({
        access_token: 'acc-new',
        refresh_token: 'ref-new',
        expires_in: 900,
      })
    },
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const result = await refreshKimiAccessTokenIfNeeded()
  expect(result.refreshed).toBe(true)
  expect(result.credentials?.accessToken).toBe('acc-new')
  expect(result.credentials?.refreshToken).toBe('ref-new')
  // Rotated token is persisted (and the read reflects it, not the stale cache).
  expect(readKimiCredentials()?.accessToken).toBe('acc-new')
  expect((await readKimiCredentialsAsync())?.accessToken).toBe('acc-new')
})

test('force refresh fires even when the token is still fresh and keeps the old refresh token', async () => {
  saveKimiCredentials({
    accessToken: 'acc-fresh',
    refreshToken: 'ref-keep',
    expiresAt: Date.now() + 900_000,
  })
  let calls = 0
  globalThis.fetch = mock(async () => {
    calls += 1
    return jsonResponse({ access_token: 'acc-forced', expires_in: 900 })
  }) as unknown as typeof fetch

  const result = await refreshKimiAccessTokenIfNeeded({ force: true })
  expect(calls).toBe(1)
  expect(result.refreshed).toBe(true)
  expect(result.credentials?.accessToken).toBe('acc-forced')
  // No refresh_token in the response → the existing one is retained.
  expect(result.credentials?.refreshToken).toBe('ref-keep')
})

test('a failed refresh persists a cooldown that blocks the next non-forced attempt', async () => {
  saveKimiCredentials({
    accessToken: 'acc-old',
    refreshToken: 'ref-old',
    expiresAt: Date.now() - 1_000,
  })
  let calls = 0
  globalThis.fetch = mock(async () => {
    calls += 1
    return jsonResponse({ error: 'invalid_grant' }, 400)
  }) as unknown as typeof fetch

  await expect(refreshKimiAccessTokenIfNeeded()).rejects.toThrow(/invalid_grant/)
  expect(calls).toBe(1)

  // Second non-forced attempt is inside the cooldown window → no network call.
  const second = await refreshKimiAccessTokenIfNeeded()
  expect(second.refreshed).toBe(false)
  expect(calls).toBe(1)
})

test('force refresh bypasses the failure cooldown', async () => {
  saveKimiCredentials({
    accessToken: 'acc-old',
    refreshToken: 'ref-old',
    expiresAt: Date.now() - 1_000,
    lastRefreshFailureAt: Date.now(),
  })
  globalThis.fetch = mock(async () =>
    jsonResponse({ access_token: 'acc-forced', expires_in: 900 }),
  ) as unknown as typeof fetch

  const result = await refreshKimiAccessTokenIfNeeded({ force: true })
  expect(result.refreshed).toBe(true)
  expect(result.credentials?.accessToken).toBe('acc-forced')
})

test('concurrent refreshes share a single in-flight request', async () => {
  saveKimiCredentials({
    accessToken: 'acc-old',
    refreshToken: 'ref-old',
    expiresAt: Date.now() - 1_000,
  })
  let calls = 0
  globalThis.fetch = mock(async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 10))
    return jsonResponse({ access_token: 'acc-new', expires_in: 900 })
  }) as unknown as typeof fetch

  const [a, b] = await Promise.all([
    refreshKimiAccessTokenIfNeeded(),
    refreshKimiAccessTokenIfNeeded(),
  ])
  expect(calls).toBe(1)
  expect(a.credentials?.accessToken).toBe('acc-new')
  expect(b.credentials?.accessToken).toBe('acc-new')
})
