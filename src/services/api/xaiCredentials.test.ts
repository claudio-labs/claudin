/**
 * These tests avoid static imports so Bun can mock secureStorage before
 * xaiCredentials is first loaded.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const realSecureStorage = { ...(await import('src/platform/secureStorage/index.js')) }

afterAll(() => {
  mock.module('src/platform/secureStorage/index.js', () => realSecureStorage)
})

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('xaiCredentials', () => {
  const originalSimple = process.env.CLAUDE_CODE_SIMPLE
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch

    if (originalSimple === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = originalSimple
    }
  })

  test('save returns failure in bare mode', async () => {
    process.env.CLAUDE_CODE_SIMPLE = '1'

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { saveXaiCredentials } = await import('./xaiCredentials.js?save-bare-mode')

    const result = saveXaiCredentials({
      accessToken: 'token',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toContain('Bare mode')
  })

  test('saveXaiCredentials uses plaintext fallback when native secure storage is unavailable', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    let lastWritten: unknown
    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: (options?: { allowPlainTextFallback?: boolean }) => {
        expect(options?.allowPlainTextFallback).toBe(true)
        return {
          read: () => ({}),
          readAsync: async () => ({}),
          update: (data: unknown) => {
            lastWritten = data
            return { success: true }
          },
          delete: () => true,
        }
      },
    }))

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { saveXaiCredentials } = await import('./xaiCredentials.js?save-with-plaintext-fallback')

    const result = saveXaiCredentials({
      accessToken: 'token',
      refreshToken: 'refresh-token',
    })

    expect(result.success).toBe(true)
    expect(result.warning).toBeUndefined()
    expect((lastWritten as Record<string, unknown>)?.xai).toBeDefined()
  })

  test('refreshXaiAccessTokenIfNeeded refreshes expired stored credentials', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
    })
    const freshAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
    })

    let storageState: Record<string, unknown> = {
      xai: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
      },
    }

    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    globalThis.fetch = mock(async (_input, init) => {
      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : ''

      if (!bodyText.includes('grant_type=refresh_token')) {
        throw new Error(`Unexpected request body: ${bodyText}`)
      }

      return new Response(
        JSON.stringify({
          access_token: freshAccessToken,
          refresh_token: 'refresh-new',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { refreshXaiAccessTokenIfNeeded, readXaiCredentials } = await import('./xaiCredentials.js?refresh-expired')

    const result = await refreshXaiAccessTokenIfNeeded()
    expect(result.refreshed).toBe(true)
    expect(result.credentials?.accessToken).toBe(freshAccessToken)

    const stored = readXaiCredentials()
    expect(stored?.accessToken).toBe(freshAccessToken)
    expect(stored?.refreshToken).toBe('refresh-new')
  })

  test('refreshXaiAccessTokenIfNeeded skips refresh when token is far from expiry', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    // Token valid for another hour — well outside the 120s skew window.
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
    })

    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          xai: { accessToken: freshToken, refreshToken: 'refresh' },
        }),
        readAsync: async () => ({
          xai: { accessToken: freshToken, refreshToken: 'refresh' },
        }),
        update: () => ({ success: true }),
      }),
    }))

    let fetchCalled = false
    globalThis.fetch = mock(async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { refreshXaiAccessTokenIfNeeded } = await import('./xaiCredentials.js?refresh-skip-fresh')

    const result = await refreshXaiAccessTokenIfNeeded()
    expect(result.refreshed).toBe(false)
    expect(fetchCalled).toBe(false)
  })

  test('refreshXaiAccessTokenIfNeeded refreshes opaque tokens via expiresAt skew', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    // Opaque (non-JWT) tokens — parseJwtExpiryMs returns undefined for both;
    // refresh must fire purely from the persisted expiresAt (within 120s skew).
    let storageState: Record<string, unknown> = {
      xai: {
        accessToken: 'opaque-old',
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 30_000, // 30s — inside 120s skew
      },
    }

    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    let fetchCalls = 0
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return new Response(
        JSON.stringify({
          access_token: 'opaque-new',
          refresh_token: 'refresh-new',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { refreshXaiAccessTokenIfNeeded, readXaiCredentials } = await import('./xaiCredentials.js?opaque-skew')

    const result = await refreshXaiAccessTokenIfNeeded()
    expect(result.refreshed).toBe(true)
    expect(result.credentials?.accessToken).toBe('opaque-new')
    expect(fetchCalls).toBe(1)
    const stored = readXaiCredentials()
    expect(stored?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000)
  })

  test('force-refresh bypasses cooldown; non-force respects cooldown', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    let storageState: Record<string, unknown> = {
      xai: {
        accessToken: 'opaque-old',
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 30_000,
        lastRefreshFailureAt: Date.now() - 5_000, // inside 60s cooldown
      },
    }

    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    let fetchCalls = 0
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return new Response(
        JSON.stringify({
          access_token: 'opaque-new',
          refresh_token: 'refresh-new',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { refreshXaiAccessTokenIfNeeded } = await import('./xaiCredentials.js?cooldown-force')

    // Non-force: cooldown blocks the network call.
    const skipped = await refreshXaiAccessTokenIfNeeded()
    expect(skipped.refreshed).toBe(false)
    expect(fetchCalls).toBe(0)

    // Force: cooldown is bypassed, network fires.
    const forced = await refreshXaiAccessTokenIfNeeded({ force: true })
    expect(forced.refreshed).toBe(true)
    expect(fetchCalls).toBe(1)
  })

  test('readXaiCredentials returns undefined silently on ENOENT but logs other errors', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' })
    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => {
          throw enoent
        },
        readAsync: async () => {
          throw enoent
        },
      }),
    }))

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { readXaiCredentials } = await import('./xaiCredentials.js?read-enoent')
    expect(readXaiCredentials()).toBeUndefined()
  })

  test('clearXaiCredentials surfaces secure-storage failure cause', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({ xai: { accessToken: 'token' } }),
        readAsync: async () => ({ xai: { accessToken: 'token' } }),
        update: () => ({ success: false, warning: 'keychain locked' }),
      }),
    }))

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { clearXaiCredentials } = await import('./xaiCredentials.js?clear-write-fail')

    const result = clearXaiCredentials()
    expect(result.success).toBe(false)
    expect(result.warning).toContain('keychain locked')
  })

  test('clearXaiCredentials removes the xai entry from secure storage', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    let storageState: Record<string, unknown> = {
      xai: { accessToken: 'token', refreshToken: 'refresh' },
      other: { keep: true },
    }

    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    // @ts-ignore — bun cache-bust query string, not recognized by tsc
    const { clearXaiCredentials } = await import('./xaiCredentials.js?clear-entry')

    const result = clearXaiCredentials()
    expect(result.success).toBe(true)
    expect(storageState.xai).toBeUndefined()
    expect(storageState.other).toEqual({ keep: true })
  })
})
