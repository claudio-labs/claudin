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

// Characterization of fetchMiniMaxUsage. The active provider comes from the
// config source (tryGetActiveProvider stays real) and fetch is stubbed.

const realConfig = { ...(await import('src/platform/config/config.js')) }
const realProviderProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }

let activeProfile: ProviderProfile | undefined

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

const { invalidateActiveProviderCache } = await import(
  'src/providers/presets/activeProvider.js'
)
const { fetchMiniMaxUsage, getMiniMaxUsageUrls } = await import(
  'src/providers/usage/minimaxUsage/fetch.js'
)
const { DEFAULT_MINIMAX_UNAVAILABLE_MESSAGE } = await import(
  'src/providers/usage/minimaxUsage/types.js'
)

const realFetch = globalThis.fetch
// getClaudinUserAgent reads the build-time MACRO, which bun test does not define.
const macroHost = globalThis as { MACRO?: unknown }
let savedMacro: unknown
const TOKEN_PLAN_URL = 'https://api.minimax.io/v1/token_plan/remains'
const CODING_PLAN_URL =
  'https://api.minimax.io/v1/api/openplatform/coding_plan/remains'

type FetchCall = { url: string; init: RequestInit | undefined }
let fetchCalls: FetchCall[] = []

/** Each entry answers one request in order: a Response, or an Error to throw. */
function stubFetch(answers: Array<() => Response | Error>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init })
    const answer = answers[fetchCalls.length - 1]
    if (!answer) throw new Error(`unexpected fetch #${fetchCalls.length}`)
    const result = answer()
    if (result instanceof Error) throw result
    return result
  }) as typeof fetch
}

function setProfile(overrides: Partial<ProviderProfile> = {}): void {
  activeProfile = {
    id: 'minimax-test',
    name: 'MiniMax',
    provider: 'openai',
    baseUrl: 'https://api.minimax.io/v1',
    model: 'MiniMax-M2.7',
    apiKey: 'mm-key',
    ...overrides,
  } as ProviderProfile
  invalidateActiveProviderCache()
}

const AVAILABLE_PAYLOAD = {
  plan_type: 'plus_highspeed',
  data: {
    'MiniMax-M2.7-highspeed': {
      current_interval_usage_count: 4200,
      max_interval_usage_count: 4500,
    },
  },
}

beforeAll(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { VERSION: '0.0.0-test' }
})

afterAll(() => {
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
  globalThis.fetch = realFetch
  activeProfile = undefined
  invalidateActiveProviderCache()
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/providers/presets/providerProfiles.js', () => realProviderProfiles)
})

beforeEach(() => {
  fetchCalls = []
  setProfile()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('fetchMiniMaxUsage', () => {
  test('throws before any request when the profile has no api key', async () => {
    setProfile({ apiKey: undefined })
    stubFetch([])

    await expect(fetchMiniMaxUsage()).rejects.toThrow(
      'MiniMax auth is required. Run /provider and configure a MiniMax profile.',
    )
    expect(fetchCalls).toHaveLength(0)
  })

  test('returns the first available result with the bearer key', async () => {
    stubFetch([() => Response.json(AVAILABLE_PAYLOAD)])

    const usage = await fetchMiniMaxUsage()

    expect(fetchCalls.map(c => c.url)).toEqual([TOKEN_PLAN_URL])
    const headers = fetchCalls[0]!.init?.headers as Record<string, string>
    expect(fetchCalls[0]!.init?.method).toBe('GET')
    expect(headers.Authorization).toBe('Bearer mm-key')
    expect(headers.Accept).toBe('application/json')
    expect(usage).toMatchObject({
      availability: 'available',
      planType: 'Plus Highspeed',
      snapshots: [{ limitName: 'MiniMax-M2.7-highspeed' }],
    })
  })

  test('falls through to the coding-plan endpoint when the first is not available', async () => {
    stubFetch([
      () => Response.json({ data: {} }),
      () => Response.json(AVAILABLE_PAYLOAD),
    ])

    const usage = await fetchMiniMaxUsage()

    expect(fetchCalls.map(c => c.url)).toEqual([TOKEN_PLAN_URL, CODING_PLAN_URL])
    expect(usage.availability).toBe('available')
  })

  test.each([400, 401, 403, 404])(
    'status %d on every endpoint is non-fatal: unavailable result',
    async status => {
      stubFetch([
        () => new Response('nope', { status }),
        () => new Response('nope', { status }),
      ])

      const usage = await fetchMiniMaxUsage()

      expect(fetchCalls).toHaveLength(2)
      expect(usage).toEqual({
        availability: 'unknown',
        snapshots: [],
        message: DEFAULT_MINIMAX_UNAVAILABLE_MESSAGE,
      })
    },
  )

  test('a non-fatal failure wins over a fatal one', async () => {
    stubFetch([
      () => new Response('boom', { status: 500 }),
      () => new Response('missing', { status: 404 }),
    ])

    const usage = await fetchMiniMaxUsage()

    expect(usage.availability).toBe('unknown')
  })

  test('only fatal failures rethrow the last one', async () => {
    stubFetch([
      () => new Error('socket hang up'),
      () => new Response('', { status: 502 }),
    ])

    await expect(fetchMiniMaxUsage()).rejects.toThrow(
      'MiniMax usage error 502: unknown error',
    )
  })

  test('a network error alone is rethrown', async () => {
    stubFetch([
      () => new Response('overloaded', { status: 529 }),
      () => new Error('ECONNRESET'),
    ])

    await expect(fetchMiniMaxUsage()).rejects.toThrow('ECONNRESET')
  })

  test('ok responses with nothing available end unavailable', async () => {
    stubFetch([
      () => Response.json({ data: {} }),
      () => Response.json({}),
    ])

    const usage = await fetchMiniMaxUsage()

    expect(fetchCalls).toHaveLength(2)
    expect(usage).toEqual({
      availability: 'unknown',
      snapshots: [],
      message: DEFAULT_MINIMAX_UNAVAILABLE_MESSAGE,
    })
  })

  test('follows a custom profile base url', async () => {
    setProfile({ baseUrl: 'https://proxy.example/minimax/v1/' })
    stubFetch([() => Response.json(AVAILABLE_PAYLOAD)])

    await fetchMiniMaxUsage()

    expect(fetchCalls[0]!.url).toBe(
      'https://proxy.example/minimax/v1/token_plan/remains',
    )
  })
})

describe('getMiniMaxUsageUrls', () => {
  test('defaults to the MiniMax API when the active profile has a blank base url', () => {
    setProfile({ baseUrl: '   ' })
    expect(getMiniMaxUsageUrls()).toEqual([TOKEN_PLAN_URL, CODING_PLAN_URL])
  })

  test('an invalid configured base url throws with the url', () => {
    expect(() => getMiniMaxUsageUrls('http://[bad')).toThrow(
      'MiniMax usage base URL is invalid: http://[bad',
    )
  })
})
