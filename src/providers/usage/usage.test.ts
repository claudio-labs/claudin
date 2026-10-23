import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import axios from 'axios'
import * as auth from 'src/providers/auth/auth.js'
import type { OAuthTokens } from 'src/providers/oauth/types.js'
import { getOauthConfig, OAUTH_BETA_HEADER } from 'src/shared/constants/oauth.js'
import { fetchUtilization } from 'src/providers/usage/usage.js'

// fetchUtilization reads the stored claude.ai login itself, whichever provider
// is active. The token source and the refresh are spied (restored by
// mockRestore) and axios.get is stubbed at the network edge.

const macroHost = globalThis as { MACRO?: unknown }
let savedMacro: unknown

let subscriber = true
let profileScope = true
let tokens: OAuthTokens | null = null
let refreshTo: OAuthTokens | null = null
let refreshCalls = 0

type AxiosGetCall = { url: string; config: unknown }
let axiosCalls: AxiosGetCall[] = []
let axiosData: unknown = {}

const spies: Array<{ mockRestore: () => void }> = []

beforeAll(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { VERSION: '9.9.9-test' }
  spies.push(
    spyOn(auth, 'isClaudeAISubscriber').mockImplementation(() => subscriber),
    spyOn(auth, 'hasProfileScope').mockImplementation(() => profileScope),
    spyOn(auth, 'getClaudeAIOAuthTokens').mockImplementation(
      // getClaudeAIOAuthTokens is a memoized function; the spy keeps its shape.
      (() => tokens) as typeof auth.getClaudeAIOAuthTokens,
    ),
    spyOn(auth, 'checkAndRefreshOAuthTokenIfNeeded').mockImplementation(async () => {
      refreshCalls++
      if (!refreshTo) return false
      tokens = refreshTo
      return true
    }),
    spyOn(axios, 'get').mockImplementation((async (url: string, config: unknown) => {
      axiosCalls.push({ url, config })
      return { data: axiosData }
    }) as typeof axios.get),
  )
})

afterAll(() => {
  for (const spy of spies) spy.mockRestore()
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

beforeEach(() => {
  subscriber = true
  profileScope = true
  tokens = {
    accessToken: 'oauth-access',
    refreshToken: 'oauth-refresh',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: null,
    rateLimitTier: null,
  }
  refreshTo = null
  refreshCalls = 0
  axiosCalls = []
  axiosData = {}
})

afterEach(() => {
  axiosCalls = []
})

describe('fetchUtilization', () => {
  test('no stored claude.ai login → empty object, no request', async () => {
    tokens = null
    expect(await fetchUtilization()).toEqual({})
    expect(axiosCalls).toHaveLength(0)
  })

  test('a login without the claude.ai inference scope → empty object, no request', async () => {
    tokens = { ...tokens!, scopes: ['user:profile'] }
    expect(await fetchUtilization()).toEqual({})
    expect(axiosCalls).toHaveLength(0)
  })

  test('a login without the profile scope → empty object, no request', async () => {
    profileScope = false
    expect(await fetchUtilization()).toEqual({})
    expect(axiosCalls).toHaveLength(0)
  })

  test('another provider being active does not hide the login', async () => {
    // isClaudeAISubscriber() is false whenever the active transport is not
    // Anthropic's; the stored login is what decides.
    subscriber = false
    await fetchUtilization()
    expect(axiosCalls).toHaveLength(1)
  })

  test('an expired OAuth token that does not refresh → null, no request', async () => {
    tokens = { ...tokens!, expiresAt: Date.now() - 1000 }
    expect(await fetchUtilization()).toBeNull()
    expect(refreshCalls).toBe(1)
    expect(axiosCalls).toHaveLength(0)
  })

  test('an expired OAuth token is refreshed, and the fresh one is sent', async () => {
    tokens = { ...tokens!, expiresAt: Date.now() - 1000 }
    refreshTo = { ...tokens, accessToken: 'oauth-fresh', expiresAt: Date.now() + 60 * 60 * 1000 }
    await fetchUtilization()
    expect(axiosCalls).toHaveLength(1)
    const config = axiosCalls[0]!.config as { headers: Record<string, string> }
    expect(config.headers.Authorization).toBe('Bearer oauth-fresh')
  })

  test('a token inside the 5-minute expiry buffer counts as expired', async () => {
    tokens = { ...tokens!, expiresAt: Date.now() + 60 * 1000 }
    expect(await fetchUtilization()).toBeNull()
  })

  test('a login with no access token throws with the reason', async () => {
    tokens = { ...tokens!, accessToken: '', expiresAt: null }
    await expect(fetchUtilization()).rejects.toThrow(
      'Auth error: No OAuth token available',
    )
    expect(axiosCalls).toHaveLength(0)
  })

  test('GETs /api/oauth/usage with the OAuth headers and returns the body', async () => {
    axiosData = {
      five_hour: { utilization: 42, resets_at: '2026-10-22T15:00:00Z' },
      seven_day: null,
    }

    const result = await fetchUtilization()

    expect(result).toEqual(axiosData as object)
    expect(axiosCalls).toHaveLength(1)
    expect(axiosCalls[0]!.url).toBe(
      `${getOauthConfig().BASE_API_URL}/api/oauth/usage`,
    )
    const config = axiosCalls[0]!.config as {
      headers: Record<string, string>
      timeout: number
    }
    expect(config.timeout).toBe(5000)
    expect(config.headers['Content-Type']).toBe('application/json')
    expect(config.headers['User-Agent']).toBe('claude-code/9.9.9-test')
    expect(config.headers.Authorization).toBe('Bearer oauth-access')
    expect(config.headers['anthropic-beta']).toBe(OAUTH_BETA_HEADER)
  })

  test('a token with no expiry is used as-is', async () => {
    tokens = { ...tokens!, expiresAt: null }
    await fetchUtilization()
    expect(axiosCalls).toHaveLength(1)
  })
})
