import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { GlobalConfig, ProviderProfile } from 'src/platform/config/config.js'
import type { CodexCredentialBlob } from 'src/providers/oauth/codexCredentials.js'

// Characterization of fetchCodexUsage. The active provider is driven through
// the config source (never by mocking tryGetActiveProvider), the Codex secure
// storage is replaced at its module boundary, and fetch is stubbed.

const realConfig = { ...(await import('src/platform/config/config.js')) }
const realProviderProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }
const realCodexCredentials = { ...(await import('src/providers/oauth/codexCredentials.js')) }

let activeProfile: ProviderProfile | undefined
type RefreshResult = { refreshed: boolean; credentials?: CodexCredentialBlob }
let refreshImpl: () => Promise<RefreshResult> = async () => ({ refreshed: false })
let readAsyncImpl: () => Promise<CodexCredentialBlob | undefined> = async () =>
  undefined
let readAsyncCalls = 0

mock.module('src/platform/config/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () =>
    ({
      providerProfiles: activeProfile ? [activeProfile] : [],
      activeProviderProfileId: activeProfile?.id,
    }) as unknown as GlobalConfig,
}))
mock.module('src/providers/presets/providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: () => activeProfile,
}))
mock.module('src/providers/oauth/codexCredentials.js', () => ({
  ...realCodexCredentials,
  refreshCodexAccessTokenIfNeeded: () => refreshImpl(),
  readCodexCredentialsAsync: () => {
    readAsyncCalls += 1
    return readAsyncImpl()
  },
}))

const { invalidateActiveProviderCache } = await import(
  'src/providers/presets/activeProvider.js'
)
const { fetchCodexUsage } = await import('src/providers/usage/codexUsage.js')

const ENV_KEYS = [
  'CODEX_API_KEY',
  'CODEX_AUTH_JSON_PATH',
  'CODEX_HOME',
  'CODEX_ACCOUNT_ID',
  'CHATGPT_ACCOUNT_ID',
  'CLAUDIN_SIMPLE',
] as const
const savedEnv: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch

type FetchCall = { url: string; init: RequestInit | undefined }
let fetchCalls: FetchCall[] = []

function stubFetch(response: () => Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init })
    return response()
  }) as typeof fetch
}

function setProfile(overrides: Partial<ProviderProfile> = {}): void {
  activeProfile = {
    id: 'codex-test',
    name: 'Codex OAuth',
    provider: 'openai',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    ...overrides,
  } as ProviderProfile
  invalidateActiveProviderCache()
}

function storedCredentials(blob: Partial<CodexCredentialBlob>): void {
  refreshImpl = async () => ({
    refreshed: false,
    credentials: blob as CodexCredentialBlob,
  })
}

const USAGE_PAYLOAD = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: {
      used_percent: 38,
      limit_window_seconds: 18_000,
      reset_at: 1_775_154_358,
    },
  },
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  globalThis.fetch = realFetch
  activeProfile = undefined
  invalidateActiveProviderCache()
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/providers/presets/providerProfiles.js', () => realProviderProfiles)
  mock.module('src/providers/oauth/codexCredentials.js', () => realCodexCredentials)
})

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  fetchCalls = []
  readAsyncCalls = 0
  refreshImpl = async () => ({ refreshed: false })
  readAsyncImpl = async () => undefined
  setProfile()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('fetchCodexUsage', () => {
  test('GETs wham/usage with the bearer, account id and originator headers', async () => {
    storedCredentials({ accessToken: 'access-1', accountId: 'acct-1' })
    stubFetch(() => Response.json(USAGE_PAYLOAD))

    const usage = await fetchCodexUsage()

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(fetchCalls[0]!.init?.method).toBe('GET')
    expect(fetchCalls[0]!.init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer access-1',
      'chatgpt-account-id': 'acct-1',
      originator: 'claudin',
    })
    expect(fetchCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    expect(usage.planType).toBe('plus')
    expect(usage.snapshots[0]).toMatchObject({
      limitName: 'codex',
      primary: { usedPercent: 38, windowMinutes: 300 },
    })
    expect(readAsyncCalls).toBe(0)
  })

  test('a failed refresh falls back to the stored credentials', async () => {
    refreshImpl = async () => {
      throw new Error('refresh endpoint down')
    }
    readAsyncImpl = async () => ({
      accessToken: 'fallback-token',
      accountId: 'acct-fallback',
    }) as CodexCredentialBlob
    stubFetch(() => Response.json(USAGE_PAYLOAD))

    await fetchCodexUsage()

    expect(readAsyncCalls).toBe(1)
    const headers = fetchCalls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer fallback-token')
    expect(headers['chatgpt-account-id']).toBe('acct-fallback')
  })

  test('rejects a profile that is not on the official Codex backend', async () => {
    setProfile({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' })
    let refreshed = false
    refreshImpl = async () => {
      refreshed = true
      return { refreshed: false }
    }
    stubFetch(() => Response.json(USAGE_PAYLOAD))

    await expect(fetchCodexUsage()).rejects.toThrow(
      'Codex usage is only available with the official ChatGPT Codex backend.',
    )
    expect(fetchCalls).toHaveLength(0)
    // Rejected before the Codex token is refreshed for nothing.
    expect(refreshed).toBe(false)
  })

  test('a Codex profile that is not the active one: its own base URL is used', async () => {
    setProfile({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' })
    storedCredentials({ accessToken: 'access-1', accountId: 'acct-1' })
    stubFetch(() => Response.json(USAGE_PAYLOAD))

    await fetchCodexUsage({ baseUrl: 'https://chatgpt.com/backend-api/codex' })

    expect(fetchCalls[0]!.url).toBe('https://chatgpt.com/backend-api/wham/usage')
  })

  test('a non-Codex base URL passed in is rejected the same way', async () => {
    await expect(
      fetchCodexUsage({ baseUrl: 'https://openrouter.ai/api/v1' }),
    ).rejects.toThrow('Codex usage is only available with the official ChatGPT Codex backend.')
  })

  test('missing api key names /provider and the auth.json path', async () => {
    process.env.CODEX_AUTH_JSON_PATH = '/nonexistent/claudin-test/auth.json'
    stubFetch(() => Response.json(USAGE_PAYLOAD))

    await expect(fetchCodexUsage()).rejects.toThrow(
      'Codex auth is required. Set CODEX_API_KEY, choose Codex OAuth in /provider or place a Codex auth.json at /nonexistent/claudin-test/auth.json.',
    )
    expect(fetchCalls).toHaveLength(0)
  })

  test('missing api key without an auth path names only /provider', async () => {
    storedCredentials({ accessToken: 'access-1', apiKey: '', accountId: 'acct-1' })
    stubFetch(() => Response.json(USAGE_PAYLOAD))

    await expect(fetchCodexUsage()).rejects.toThrow(
      /^Codex auth is required\. Set CODEX_API_KEY, choose Codex OAuth in \/provider\.$/,
    )
  })

  test('bare mode drops the /provider hint', async () => {
    process.env.CLAUDIN_SIMPLE = '1'
    storedCredentials({ accessToken: 'access-1', apiKey: '', accountId: 'acct-1' })
    stubFetch(() => Response.json(USAGE_PAYLOAD))

    await expect(fetchCodexUsage()).rejects.toThrow(
      /^Codex auth is required\. Set CODEX_API_KEY\.$/,
    )
  })

  test('missing account id is an error before any request', async () => {
    storedCredentials({ accessToken: 'opaque-not-a-jwt' })
    stubFetch(() => Response.json(USAGE_PAYLOAD))

    await expect(fetchCodexUsage()).rejects.toThrow(
      'Codex auth is missing chatgpt_account_id.',
    )
    expect(fetchCalls).toHaveLength(0)
  })

  test('a non-ok response surfaces the status and body', async () => {
    storedCredentials({ accessToken: 'access-1', accountId: 'acct-1' })
    stubFetch(() => new Response('upstream down', { status: 503 }))

    await expect(fetchCodexUsage()).rejects.toThrow(
      'Codex usage error 503: upstream down',
    )
  })
})
