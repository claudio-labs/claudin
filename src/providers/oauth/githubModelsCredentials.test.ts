import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const realSecureStorage = { ...(await import('src/platform/secureStorage/index.js')) }
const realActiveProvider = { ...(await import('src/providers/presets/activeProvider.js')) }
const realDeviceFlow = { ...(await import('src/platform/github/deviceFlow.js')) }
const realProviderProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }

afterAll(() => {
  mock.module('src/platform/secureStorage/index.js', () => realSecureStorage)
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProvider)
  mock.module('src/platform/github/deviceFlow.js', () => realDeviceFlow)
  mock.module('src/providers/presets/providerProfiles.js', () => realProviderProfiles)
})

describe('readGithubModelsToken', () => {
  test('returns undefined in bare mode', async () => {
    const { readGithubModelsToken } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?read-bare-mode'
    )

    const prev = process.env.CLAUDIN_SIMPLE
    process.env.CLAUDIN_SIMPLE = '1'
    expect(readGithubModelsToken()).toBeUndefined()
    if (prev === undefined) {
      delete process.env.CLAUDIN_SIMPLE
    } else {
      process.env.CLAUDIN_SIMPLE = prev
    }
  })
})

describe('saveGithubModelsToken / clearGithubModelsToken', () => {
  test('save returns failure in bare mode', async () => {
    const { saveGithubModelsToken } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?save-bare-mode'
    )

    const prev = process.env.CLAUDIN_SIMPLE
    process.env.CLAUDIN_SIMPLE = '1'
    const r = saveGithubModelsToken('abc')
    expect(r.success).toBe(false)
    expect(r.warning).toContain('Bare mode')
    if (prev === undefined) {
      delete process.env.CLAUDIN_SIMPLE
    } else {
      process.env.CLAUDIN_SIMPLE = prev
    }
  })

  test('clear succeeds in bare mode', async () => {
    const { clearGithubModelsToken } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?clear-bare-mode'
    )

    const prev = process.env.CLAUDIN_SIMPLE
    process.env.CLAUDIN_SIMPLE = '1'
    expect(clearGithubModelsToken().success).toBe(true)
    if (prev === undefined) {
      delete process.env.CLAUDIN_SIMPLE
    } else {
      process.env.CLAUDIN_SIMPLE = prev
    }
  })
})

function makeCopilotToken(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(
    JSON.stringify({ exp: expSeconds, 'github-copilot': true }),
  ).toString('base64url')
  return `${header}.${body}.signature`
}

describe('refreshGithubModelsTokenIfNeeded', () => {
  const originalSimple = process.env.CLAUDIN_SIMPLE

  afterEach(() => {
    if (originalSimple === undefined) {
      delete process.env.CLAUDIN_SIMPLE
    } else {
      process.env.CLAUDIN_SIMPLE = originalSimple
    }
  })

  test('returns false when not on github_copilot transport', async () => {
    delete process.env.CLAUDIN_SIMPLE

    mock.module('src/providers/presets/activeProvider.js', () => ({
      tryGetActiveProvider: () => ({ transport: 'anthropic' }),
    }))

    const { refreshGithubModelsTokenIfNeeded } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?refresh-not-copilot'
    )

    const result = await refreshGithubModelsTokenIfNeeded()
    expect(result).toBe(false)
  })

  test('returns false when bare mode is active', async () => {
    process.env.CLAUDIN_SIMPLE = '1'

    const { refreshGithubModelsTokenIfNeeded } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?refresh-bare'
    )

    const result = await refreshGithubModelsTokenIfNeeded()
    expect(result).toBe(false)
  })

  test('returns false when token is still valid', async () => {
    delete process.env.CLAUDIN_SIMPLE

    const validToken = makeCopilotToken(
      Math.floor((Date.now() + 3_600_000) / 1000),
    )

    let storageState: Record<string, unknown> = {
      githubModels: {
        accessToken: validToken,
        oauthAccessToken: 'oauth-token-123',
      },
    }

    mock.module('src/providers/presets/activeProvider.js', () => ({
      tryGetActiveProvider: () => ({ transport: 'github_copilot' }),
    }))
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

    const { refreshGithubModelsTokenIfNeeded } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?refresh-valid-token'
    )

    const result = await refreshGithubModelsTokenIfNeeded()
    expect(result).toBe(false)
  })

  test('refreshes expired token and updates profile', async () => {
    delete process.env.CLAUDIN_SIMPLE

    const expiredToken = makeCopilotToken(
      Math.floor((Date.now() - 60_000) / 1000),
    )
    const freshToken = makeCopilotToken(
      Math.floor((Date.now() + 3_600_000) / 1000),
    )

    let storageState: Record<string, unknown> = {
      githubModels: {
        accessToken: expiredToken,
        oauthAccessToken: 'oauth-token-123',
      },
    }

    const updatedProfiles: Array<Record<string, unknown>> = []

    mock.module('src/providers/presets/activeProvider.js', () => ({
      tryGetActiveProvider: () => ({ transport: 'github_copilot' }),
    }))
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
    mock.module('src/platform/github/deviceFlow.js', () => ({
      exchangeForCopilotToken: mock(async () => ({
        token: freshToken,
        expires_at: Math.floor((Date.now() + 3_600_000) / 1000),
        refresh_in: 1800,
        endpoints: { api: 'https://api.githubcopilot.com' },
      })),
    }))
    mock.module('src/providers/presets/providerProfiles.js', () => ({
      getProviderProfiles: () => [
        {
          id: 'profile_copilot',
          provider: 'openai',
          name: 'Copilot',
          baseUrl: 'https://api.githubcopilot.com',
          model: 'gpt-4o',
          extras: { githubToken: expiredToken },
        },
      ],
      updateProviderProfile: mock((id: string, _data: unknown) => {
        updatedProfiles.push({ id })
        return { success: true }
      }),
    }))

    const { refreshGithubModelsTokenIfNeeded } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?refresh-expired-token'
    )

    const result = await refreshGithubModelsTokenIfNeeded()
    expect(result).toBe(true)
    expect(updatedProfiles).toHaveLength(1)
    expect(updatedProfiles[0].id).toBe('profile_copilot')
  })

  test('returns false when no tokens are stored', async () => {
    delete process.env.CLAUDIN_SIMPLE

    let storageState: Record<string, unknown> = {}

    mock.module('src/providers/presets/activeProvider.js', () => ({
      tryGetActiveProvider: () => ({ transport: 'github_copilot' }),
    }))
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

    const { refreshGithubModelsTokenIfNeeded } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?refresh-no-tokens'
    )

    const result = await refreshGithubModelsTokenIfNeeded()
    expect(result).toBe(false)
  })

  test('deduplicates concurrent refresh attempts', async () => {
    delete process.env.CLAUDIN_SIMPLE

    const expiredToken = makeCopilotToken(
      Math.floor((Date.now() - 60_000) / 1000),
    )
    const freshToken = makeCopilotToken(
      Math.floor((Date.now() + 3_600_000) / 1000),
    )

    let storageState: Record<string, unknown> = {
      githubModels: {
        accessToken: expiredToken,
        oauthAccessToken: 'oauth-token-123',
      },
    }

    let exchangeAttempts = 0
    let releaseExchange: (() => void) | undefined
    const exchangeGate = new Promise<void>(resolve => {
      releaseExchange = resolve
    })

    mock.module('src/providers/presets/activeProvider.js', () => ({
      tryGetActiveProvider: () => ({ transport: 'github_copilot' }),
    }))
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
    mock.module('src/platform/github/deviceFlow.js', () => ({
      exchangeForCopilotToken: mock(async () => {
        exchangeAttempts += 1
        await exchangeGate
        return {
          token: freshToken,
          expires_at: Math.floor((Date.now() + 3_600_000) / 1000),
          refresh_in: 1800,
          endpoints: { api: 'https://api.githubcopilot.com' },
        }
      }),
    }))
    mock.module('src/providers/presets/providerProfiles.js', () => ({
      getProviderProfiles: () => [],
      updateProviderProfile: mock(() => ({ success: true })),
    }))

    const { refreshGithubModelsTokenIfNeeded } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?refresh-dedupe'
    )

    // Fire two concurrent refresh calls
    const firstRefresh = refreshGithubModelsTokenIfNeeded()
    const secondRefresh = refreshGithubModelsTokenIfNeeded()

    // Release the gate so the single HTTP call completes
    releaseExchange?.()

    const [firstResult, secondResult] = await Promise.all([
      firstRefresh,
      secondRefresh,
    ])

    // Both callers must get true (token was refreshed)
    expect(firstResult).toBe(true)
    expect(secondResult).toBe(true)

    // Only one HTTP call must have been made (single-flight dedup)
    expect(exchangeAttempts).toBe(1)
  })

  test('clears in-flight promise after completion to allow subsequent refreshes', async () => {
    delete process.env.CLAUDIN_SIMPLE

    const expiredToken = makeCopilotToken(
      Math.floor((Date.now() - 60_000) / 1000),
    )
    const freshToken = makeCopilotToken(
      Math.floor((Date.now() + 3_600_000) / 1000),
    )

    let storageState: Record<string, unknown> = {
      githubModels: {
        accessToken: expiredToken,
        oauthAccessToken: 'oauth-token-123',
      },
    }

    let exchangeCalls = 0

    mock.module('src/providers/presets/activeProvider.js', () => ({
      tryGetActiveProvider: () => ({ transport: 'github_copilot' }),
    }))
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
    mock.module('src/platform/github/deviceFlow.js', () => ({
      exchangeForCopilotToken: mock(async () => {
        exchangeCalls += 1
        return {
          token: freshToken,
          expires_at: Math.floor((Date.now() + 3_600_000) / 1000),
          refresh_in: 1800,
          endpoints: { api: 'https://api.githubcopilot.com' },
        }
      }),
    }))
    mock.module('src/providers/presets/providerProfiles.js', () => ({
      getProviderProfiles: () => [],
      updateProviderProfile: mock(() => ({ success: true })),
    }))

    const { refreshGithubModelsTokenIfNeeded } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './githubModelsCredentials.js?refresh-clears-flight'
    )

    // First refresh completes normally
    const firstResult = await refreshGithubModelsTokenIfNeeded()
    expect(firstResult).toBe(true)
    expect(exchangeCalls).toBe(1)

    // After completion, reset storage to expired again to trigger another refresh
    storageState = {
      githubModels: {
        accessToken: expiredToken,
        oauthAccessToken: 'oauth-token-123',
      },
    }

    // Second refresh should make a new HTTP call (in-flight was cleared)
    const secondResult = await refreshGithubModelsTokenIfNeeded()
    expect(secondResult).toBe(true)
    expect(exchangeCalls).toBe(2)
  })
})