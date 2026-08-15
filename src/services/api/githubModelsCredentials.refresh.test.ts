import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { GlobalConfig, ProviderProfile } from 'src/platform/config/config.js'

async function importFreshModule() {
  return import(`./githubModelsCredentials.ts?ts=${Date.now()}-${Math.random()}`)
}

let mockProviderProfile: ProviderProfile | null = null
// Spread into plain objects so afterAll restores the original bindings, not
// the live ESM namespaces (which mock.module mutates after the fact).
const realConfig = { ...(await import('src/platform/config/config.js')) }
const realProviderProfiles = { ...(await import('src/services/api/providerProfiles.js')) }
const realDeviceFlow = { ...(await import('src/platform/github/deviceFlow.js')) }
const realSecureStorage = { ...(await import('src/platform/secureStorage/index.js')) }

mock.module('src/platform/config/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    providerProfiles: mockProviderProfile ? [mockProviderProfile] : [],
    activeProviderProfileId: mockProviderProfile?.id,
  } as unknown as GlobalConfig),
}))

mock.module('src/services/api/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => mockProviderProfile ?? undefined,
}))

afterAll(() => {
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/services/api/providerProfiles.js', () => realProviderProfiles)
  mock.module('src/platform/github/deviceFlow.js', () => realDeviceFlow)
  // beforeEach mocks ./secureStorage/index.js but nothing restored it, so the
  // final in-memory stub leaked into every later file's real getSecureStorage()
  // (credential save/read round-trips returned undefined). Restore both the
  // relative form used here and the src/... alias other files import.
  mock.module('src/platform/secureStorage/index.js', () => realSecureStorage)
  mock.module('src/platform/secureStorage/index.js', () => realSecureStorage)
})

import { invalidateActiveProviderCache } from 'src/services/api/activeProvider.js'

function mockActiveProvider(transport: 'github_copilot' | 'anthropic' = 'github_copilot') {
  // github_copilot transport requires provider:'openai' + extras.githubToken
  mockProviderProfile = {
    id: 'gh',
    name: 'GitHub',
    provider: transport === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'github:copilot',
    extras: transport === 'github_copilot' ? { githubToken: 'gh-test' } : undefined,
  } as ProviderProfile
  invalidateActiveProviderCache()
}

describe('refreshGithubModelsTokenIfNeeded', () => {
  const orig = {
    CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  }

  beforeEach(() => {
    mock.module('src/platform/secureStorage/index.js', () => ({}))
    mock.module('src/platform/github/deviceFlow.js', () => realDeviceFlow)
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) {
        delete process.env[k as keyof typeof orig]
      } else {
        process.env[k as keyof typeof orig] = v
      }
    }
  })

  test('refreshes expired Copilot token using stored OAuth token', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    mockActiveProvider('github_copilot')

    const futureExp = Math.floor(Date.now() / 1000) + 3600
    let store: Record<string, unknown> = {
      githubModels: {
        accessToken: 'tid=stale;exp=1;sku=free',
        oauthAccessToken: 'ghu_oauth_secret',
      },
    }

    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => store,
        update: (next: Record<string, unknown>) => {
          store = next
          return { success: true }
        },
      }),
    }))

    mock.module('src/platform/github/deviceFlow.js', () => ({
      ...realDeviceFlow,
      exchangeForCopilotToken: async () => ({
        token: `tid=fresh;exp=${futureExp};sku=free`,
        expires_at: futureExp,
        refresh_in: 1500,
        endpoints: { api: 'https://api.githubcopilot.com' },
      }),
    }))

    const { refreshGithubModelsTokenIfNeeded } = await importFreshModule()

    const refreshed = await refreshGithubModelsTokenIfNeeded()
    expect(refreshed).toBe(true)

    const githubModels = (store.githubModels ?? {}) as {
      accessToken?: string
      oauthAccessToken?: string
    }
    expect(githubModels.accessToken?.startsWith('tid=fresh;exp=')).toBe(true)
    expect(githubModels.oauthAccessToken).toBe('ghu_oauth_secret')
  })

  test('does not refresh when current Copilot token is valid', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    mockActiveProvider('github_copilot')

    const futureExp = Math.floor(Date.now() / 1000) + 3600
    const exchangeSpy = mock(async () => ({
      token: `tid=unexpected;exp=${futureExp};sku=free`,
      expires_at: futureExp,
      refresh_in: 1500,
      endpoints: { api: 'https://api.githubcopilot.com' },
    }))

    mock.module('src/platform/secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: `tid=already-valid;exp=${futureExp};sku=free`,
            oauthAccessToken: 'ghu_oauth_secret',
          },
        }),
        update: () => ({ success: true }),
      }),
    }))

    mock.module('src/platform/github/deviceFlow.js', () => ({
      DEFAULT_GITHUB_DEVICE_SCOPE: 'read:user',
      exchangeForCopilotToken: exchangeSpy,
    }))

    const { refreshGithubModelsTokenIfNeeded } = await importFreshModule()

    const refreshed = await refreshGithubModelsTokenIfNeeded()
    expect(refreshed).toBe(false)
    expect(exchangeSpy).not.toHaveBeenCalled()
  })
})
