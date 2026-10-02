/**
 * Pins the `claudin auth login|status|logout` handlers and the token install
 * they share with the OAuth UI, before the remote-settings and policy-limits
 * cut edits auth.ts.
 *
 * Isolation, all real: a temp CLAUDIN_CONFIG_DIR, a `secret-tool` on PATH that
 * always fails (so credentials fall back to the plaintext file in that dir and
 * the desktop keyring is never touched), and a browser that is a script in
 * the temp dir. The one stand-in is the HTTP boundary: axios's adapter answers
 * for the OAuth and profile endpoints, which cannot be pointed at localhost.
 *
 * `process.exit` throws so the handlers stop where the CLI would. Inside
 * authLogin's try that throw is caught and reported as a failure, so a
 * successful login records exit codes [0, 1]: the first one is the CLI's.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  authLogin,
  authLogout,
  authStatus,
  installOAuthTokens,
  performLogout,
} from 'src/platform/headless/handlers/auth.js'
import { getCurrentProjectConfig, getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import { getAuthVersion } from 'src/providers/auth/authChanged.js'
import { getOauthTokenFromFd, setOauthTokenFromFd } from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { OAuthTokens } from 'src/providers/oauth/types.js'

// ── process and HTTP boundary ───────────────────────────────────────────────

class ProcessExit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`)
  }
}

type Reply = { status: number; data?: unknown }
type Seen = { route: string; body: unknown; authorization: string | undefined }

const TOKEN = 'POST platform.claude.com/v1/oauth/token'
const PROFILE = 'GET api.anthropic.com/api/oauth/profile'
const ROLES = 'GET api.anthropic.com/api/oauth/claude_cli/roles'
const API_KEY = 'POST api.anthropic.com/api/oauth/claude_cli/create_api_key'

let routes: Record<string, (body: unknown) => Reply> = {}
let seen: Seen[] = []

async function answer(config: InternalAxiosRequestConfig) {
  const url = new URL(String(config.url))
  const route = `${String(config.method).toUpperCase()} ${url.host}${url.pathname}`
  const body = typeof config.data === 'string' && config.data ? JSON.parse(config.data) : (config.data ?? null)
  const authorization = config.headers?.Authorization as string | undefined
  seen.push({ route, body, authorization })
  const reply = routes[route]?.(body) ?? { status: 404, data: { error: `no route for ${route}` } }
  const response = { data: reply.data, status: reply.status, statusText: `status ${reply.status}`, headers: {}, config, request: {} }
  if (reply.status >= 400) {
    throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_RESPONSE', config, {}, response as never)
  }
  return response
}

const routesSeen = () => seen.map(s => s.route)

// ── fixtures ────────────────────────────────────────────────────────────────

const PROFILE_BODY = {
  account: { uuid: 'acct-1', email: 'ada@example.com', display_name: 'Ada', created_at: '2025-01-02T00:00:00Z' },
  organization: {
    uuid: 'org-1',
    organization_type: 'claude_max',
    rate_limit_tier: 'default_claude_max_5x',
    has_extra_usage_enabled: true,
    billing_type: 'stripe_subscription',
    subscription_created_at: '2025-02-03T00:00:00Z',
  },
}
const ROLES_BODY = { organization_role: 'admin', workspace_role: 'developer', organization_name: 'Analytical Engines' }
const SUBSCRIBER_SCOPES = ['user:inference', 'user:profile']
const CONSOLE_SCOPES = ['org:create_api_key', 'user:profile']

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'at-new',
    refreshToken: 'rt-new',
    expiresAt: Date.now() + 3_600_000,
    scopes: SUBSCRIBER_SCOPES,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
    profile: PROFILE_BODY as never,
    ...overrides,
  } as OAuthTokens
}

// ── per-test sandbox ────────────────────────────────────────────────────────

const envBefore = { ...process.env }
const fdTokenBefore = getOauthTokenFromFd()
const adapterBefore = axios.defaults.adapter
const TOUCHED_CONFIG_KEYS = [
  'oauthAccount',
  'primaryApiKey',
  'customApiKeyResponses',
  'hasCompletedOnboarding',
  'subscriptionNoticeCount',
  'hasAvailableSubscription',
  'claudeCodeFirstTokenDate',
  'providerProfiles',
  'activeProviderProfileId',
  'oauthBrowser',
] as const
const configBefore = Object.fromEntries(
  TOUCHED_CONFIG_KEYS.map(key => [key, getGlobalConfig()[key as keyof ReturnType<typeof getGlobalConfig>]]),
)
const projectProfileBefore = getCurrentProjectConfig().activeProviderProfileId

let scratch = ''
let configDir = ''
let exits: (number | undefined)[] = []
let stdout = ''
let stderr = ''
let spies: { mockRestore(): void }[] = []

const credentialsPath = () => join(configDir, '.credentials.json')
const readCredentials = () =>
  existsSync(credentialsPath()) ? JSON.parse(readFileSync(credentialsPath(), 'utf8')) : null

function writeUserSettings(settings: Record<string, unknown>): void {
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
}

function setConfig(patch: Record<string, unknown>): void {
  saveGlobalConfig(current => ({ ...current, ...patch }))
  clearOAuthTokenCache()
}

/** Runs a handler to the point where the CLI would exit. */
async function cli(handler: () => Promise<void>): Promise<void> {
  try {
    await handler()
  } catch (error) {
    if (!(error instanceof ProcessExit)) throw error
  }
}

async function until(what: string, check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'auth-handlers-char-'))
  configDir = join(scratch, 'config')
  const bin = join(scratch, 'bin')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(bin)
  const failingSecretTool = join(bin, 'secret-tool')
  writeFileSync(failingSecretTool, '#!/bin/sh\nexit 1\n')
  chmodSync(failingSecretTool, 0o755)

  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDIN_USE_|AWS_|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)/.test(key)) {
      delete process.env[key]
    }
  }
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.PATH = `${bin}:${envBefore.PATH ?? ''}`
  delete process.env.BROWSER

  exits = []
  stdout = ''
  stderr = ''
  routes = {}
  seen = []
  axios.defaults.adapter = answer as never
  spies = [
    spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code)
      throw new ProcessExit(code)
    }) as never),
    spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk)
      return true
    }) as never),
    spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as never),
  ]

  setConfig({
    oauthAccount: undefined,
    primaryApiKey: undefined,
    customApiKeyResponses: undefined,
    claudeCodeFirstTokenDate: undefined,
    providerProfiles: [],
    activeProviderProfileId: undefined,
    // Should the fake browser ever fail, openBrowser falls back to this
    // rather than to the desktop's real browser.
    oauthBrowser: 'true',
  })
  writeUserSettings({})
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  axios.defaults.adapter = adapterBefore
  for (const key of Object.keys(process.env)) {
    if (!(key in envBefore)) delete process.env[key]
  }
  Object.assign(process.env, envBefore)
  setOauthTokenFromFd(fdTokenBefore as never)
  saveGlobalConfig(current => ({ ...current, ...configBefore }))
  getCurrentProjectConfig().activeProviderProfileId = projectProfileBefore
  clearOAuthTokenCache()
  resetSettingsCache()
  rmSync(scratch, { recursive: true, force: true })
})

// ── performLogout ───────────────────────────────────────────────────────────

describe('performLogout', () => {
  const cases = [
    {
      name: 'keeps onboarding by default',
      clearOnboarding: false,
      responses: { approved: ['k1'], rejected: ['k2'] },
      expected: {
        hasCompletedOnboarding: true,
        subscriptionNoticeCount: 3,
        hasAvailableSubscription: true,
        customApiKeyResponses: { approved: ['k1'], rejected: ['k2'] },
      },
    },
    {
      name: 'resets onboarding and forgets approved keys when asked',
      clearOnboarding: true,
      responses: { approved: ['k1'], rejected: ['k2'] },
      expected: {
        hasCompletedOnboarding: false,
        subscriptionNoticeCount: 0,
        hasAvailableSubscription: false,
        customApiKeyResponses: { approved: [], rejected: ['k2'] },
      },
    },
    {
      name: 'leaves the responses alone when none were approved',
      clearOnboarding: true,
      responses: { rejected: ['k2'] },
      expected: {
        hasCompletedOnboarding: false,
        subscriptionNoticeCount: 0,
        hasAvailableSubscription: false,
        customApiKeyResponses: { rejected: ['k2'] },
      },
    },
  ]
  for (const { name, clearOnboarding, responses, expected } of cases) {
    test(`wipes credentials and the account, and ${name}`, async () => {
      writeFileSync(credentialsPath(), JSON.stringify({ claudeAiOauth: { accessToken: 'old' } }))
      setConfig({
        oauthAccount: { accountUuid: 'old', emailAddress: 'old@example.com' },
        primaryApiKey: 'sk-old',
        hasCompletedOnboarding: true,
        subscriptionNoticeCount: 3,
        hasAvailableSubscription: true,
        customApiKeyResponses: responses,
      })
      const authVersion = getAuthVersion()

      await performLogout({ clearOnboarding })

      const config = getGlobalConfig()
      expect({
        credentialsFile: existsSync(credentialsPath()),
        oauthAccount: config.oauthAccount,
        primaryApiKey: config.primaryApiKey,
        hasCompletedOnboarding: config.hasCompletedOnboarding,
        subscriptionNoticeCount: config.subscriptionNoticeCount,
        hasAvailableSubscription: config.hasAvailableSubscription,
        customApiKeyResponses: config.customApiKeyResponses,
      }).toEqual({ credentialsFile: false, oauthAccount: undefined, primaryApiKey: undefined, ...expected })
      expect(getAuthVersion()).toBe(authVersion + 1)
    })
  }
})

// ── installOAuthTokens ──────────────────────────────────────────────────────

describe('installOAuthTokens', () => {
  test('a claude.ai login stores the account, the tokens and the roles', async () => {
    routes[ROLES] = () => ({ status: 200, data: ROLES_BODY })
    setConfig({ primaryApiKey: 'sk-from-before' })

    await installOAuthTokens(tokens())

    expect(getGlobalConfig().oauthAccount).toEqual({
      accountUuid: 'acct-1',
      emailAddress: 'ada@example.com',
      organizationUuid: 'org-1',
      displayName: 'Ada',
      hasExtraUsageEnabled: true,
      billingType: 'stripe_subscription',
      subscriptionCreatedAt: '2025-02-03T00:00:00Z',
      accountCreatedAt: '2025-01-02T00:00:00Z',
      organizationRole: 'admin',
      workspaceRole: 'developer',
      organizationName: 'Analytical Engines',
    })
    expect(readCredentials()?.claudeAiOauth).toMatchObject({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      scopes: SUBSCRIBER_SCOPES,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    })
    // The old login is gone, and no API key was minted.
    expect(getGlobalConfig().primaryApiKey).toBeUndefined()
    // The first-token date is attempted too, but its User-Agent reads a build
    // macro that bun test does not define, so that request never leaves.
    expect(routesSeen()).not.toContain(API_KEY)
    expect(routesSeen()).not.toContain(PROFILE)
    expect(seen.find(s => s.route === ROLES)?.authorization).toBe('Bearer at-new')
  })

  const accountCases = [
    {
      name: 'a profile with email_address and no display name',
      tokens: tokens({
        profile: { account: { uuid: 'acct-2', email_address: 'b@example.com', display_name: '' }, organization: null } as never,
      }),
      profileRoute: undefined,
      account: { accountUuid: 'acct-2', emailAddress: 'b@example.com' },
    },
    {
      name: 'no profile, fetched from the profile endpoint',
      tokens: tokens({ profile: undefined }),
      profileRoute: { status: 200, data: PROFILE_BODY },
      account: { accountUuid: 'acct-1', emailAddress: 'ada@example.com', organizationUuid: 'org-1', displayName: 'Ada' },
    },
    {
      name: 'no profile and the endpoint failing, from the token exchange account',
      tokens: tokens({
        profile: undefined,
        tokenAccount: { uuid: 'acct-3', emailAddress: 'c@example.com', organizationUuid: 'org-3' },
      }),
      profileRoute: { status: 500, data: {} },
      account: { accountUuid: 'acct-3', emailAddress: 'c@example.com', organizationUuid: 'org-3' },
    },
    {
      name: 'nothing to go on',
      tokens: tokens({ profile: undefined }),
      profileRoute: { status: 500, data: {} },
      account: undefined,
    },
  ]
  for (const { name, tokens: given, profileRoute, account } of accountCases) {
    test(`the account comes from ${name}`, async () => {
      if (profileRoute) routes[PROFILE] = () => profileRoute
      // Roles failing is not fatal for a login.
      routes[ROLES] = () => ({ status: 503, data: {} })

      await installOAuthTokens(given)

      const stored = getGlobalConfig().oauthAccount
      if (account === undefined) expect(stored).toBeUndefined()
      else expect(stored).toMatchObject(account)
      expect(readCredentials()?.claudeAiOauth?.accessToken).toBe('at-new')
    })
  }

  test('a console login mints an API key instead of keeping the tokens', async () => {
    routes[ROLES] = () => ({ status: 200, data: ROLES_BODY })
    routes[API_KEY] = () => ({ status: 200, data: { raw_key: 'sk-ant-minted_key-1' } })

    await installOAuthTokens(tokens({ scopes: CONSOLE_SCOPES }))

    expect(getGlobalConfig().primaryApiKey).toBe('sk-ant-minted_key-1')
    expect(seen.find(s => s.route === API_KEY)?.authorization).toBe('Bearer at-new')
    expect(readCredentials()).toBeNull()
  })

  test('a console login fails when the server returns no key', async () => {
    routes[ROLES] = () => ({ status: 200, data: ROLES_BODY })
    routes[API_KEY] = () => ({ status: 200, data: {} })
    await expect(installOAuthTokens(tokens({ scopes: CONSOLE_SCOPES }))).rejects.toThrow(
      'Unable to create API key. The server accepted the request but did not return a key.',
    )
  })
})

// ── authLogin ───────────────────────────────────────────────────────────────

describe('authLogin', () => {
  test('--console with --claudeai is refused', async () => {
    await cli(() => authLogin({ console: true, claudeai: true }))
    expect(exits).toEqual([1])
    expect(stderr).toBe('Error: --console and --claudeai cannot be used together.\n')
    expect(seen).toEqual([])
  })

  test('a refresh token in the environment needs its scopes', async () => {
    process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = 'rt-env'
    await cli(() => authLogin({}))
    expect(exits).toEqual([1])
    expect(stderr).toStartWith('CLAUDE_CODE_OAUTH_SCOPES is required when using CLAUDE_CODE_OAUTH_REFRESH_TOKEN.\n')
    expect(seen).toEqual([])
  })

  test('a refresh token in the environment logs in without a browser', async () => {
    process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = 'rt-env'
    process.env.CLAUDE_CODE_OAUTH_SCOPES = '  user:inference   user:profile '
    routes[TOKEN] = () => ({
      status: 200,
      data: { access_token: 'at-env', refresh_token: 'rt-rotated', expires_in: 3600, scope: 'user:inference user:profile' },
    })
    routes[PROFILE] = () => ({ status: 200, data: PROFILE_BODY })
    routes[ROLES] = () => ({ status: 200, data: ROLES_BODY })
    setConfig({ hasCompletedOnboarding: false })

    await cli(() => authLogin({}))

    expect(exits[0]).toBe(0)
    expect(stdout).toBe('Login successful.\n')
    expect(seen.find(s => s.route === TOKEN)?.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt-env',
      scope: 'user:inference user:profile',
    })
    expect(readCredentials()?.claudeAiOauth).toMatchObject({ accessToken: 'at-env', refreshToken: 'rt-rotated' })
    expect(getGlobalConfig().hasCompletedOnboarding).toBe(true)
  })

  test('a refused refresh token is reported and exits 1', async () => {
    process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = 'rt-env'
    process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference'
    routes[TOKEN] = () => ({ status: 400, data: { error: 'invalid_grant' } })

    await cli(() => authLogin({}))

    expect(exits).toEqual([1])
    expect(stderr).toStartWith('Login failed: Request failed with status code 400\n')
    expect(stdout).toBe('')
  })

  describe('through the browser', () => {
    let browserLog = ''

    beforeEach(() => {
      browserLog = join(scratch, 'browser.json')
      const browser = join(scratch, 'bin', 'fake-browser')
      // Follows the authorize URL the way a signed-in user would: straight
      // back to the local callback with a code and the same state.
      writeFileSync(
        browser,
        [
          '#!/usr/bin/env bun',
          'try {',
          '  const opened = new URL(process.argv[2])',
          "  const back = new URL(opened.searchParams.get('redirect_uri'))",
          "  back.hostname = '127.0.0.1'",
          "  back.searchParams.set('code', 'char-code')",
          "  back.searchParams.set('state', opened.searchParams.get('state'))",
          "  const res = await fetch(back, { redirect: 'manual' })",
          "  await Bun.write(process.env.CHAR_BROWSER_LOG, JSON.stringify({ opened: opened.href, status: res.status, location: res.headers.get('location') }))",
          '} catch (error) {',
          '  await Bun.write(process.env.CHAR_BROWSER_LOG, JSON.stringify({ error: String(error) }))',
          '}',
          '',
        ].join('\n'),
      )
      chmodSync(browser, 0o755)
      process.env.BROWSER = browser
      process.env.CHAR_BROWSER_LOG = browserLog
    })

    const readBrowser = async () => {
      await until('the browser', () => existsSync(browserLog))
      return JSON.parse(readFileSync(browserLog, 'utf8')) as { opened: string; status: number; location: string | null }
    }

    test('a claude.ai sign-in exchanges the code and installs the login', async () => {
      routes[TOKEN] = () => ({
        status: 200,
        data: {
          access_token: 'at-browser',
          refresh_token: 'rt-browser',
          expires_in: 3600,
          scope: 'user:inference user:profile',
          account: { uuid: 'acct-1', email_address: 'ada@example.com' },
          organization: { uuid: 'org-1' },
        },
      })
      routes[PROFILE] = () => ({ status: 200, data: PROFILE_BODY })
      routes[ROLES] = () => ({ status: 200, data: ROLES_BODY })

      await cli(() => authLogin({}))
      const browser = await readBrowser()

      expect(exits[0]).toBe(0)
      const lines = stdout.split('\n')
      expect(lines[0]).toBe('Opening browser to sign in…')
      expect(lines[1]).toStartWith("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?")
      expect(lines.slice(2)).toEqual(['Login successful.', ''])
      // The printed URL is the manual one; the browser got the local callback.
      expect(new URL(lines[1]!.split('visit: ')[1]!).searchParams.get('redirect_uri')).toBe(
        'https://platform.claude.com/oauth/code/callback',
      )
      expect(new URL(browser.opened).searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/)
      expect({ status: browser.status, location: browser.location }).toEqual({
        status: 302,
        location: 'https://platform.claude.com/oauth/code/success?app=claude-code',
      })
      expect(seen.find(s => s.route === TOKEN)?.body).toMatchObject({
        grant_type: 'authorization_code',
        code: 'char-code',
        redirect_uri: new URL(browser.opened).searchParams.get('redirect_uri'),
        state: new URL(browser.opened).searchParams.get('state'),
      })
      expect(readCredentials()?.claudeAiOauth).toMatchObject({ accessToken: 'at-browser', subscriptionType: 'max' })
      expect(getGlobalConfig().oauthAccount?.organizationName).toBe('Analytical Engines')
    })

    const urlCases = [
      {
        name: 'no flags go to claude.ai',
        options: {},
        settings: {},
        authorize: 'https://claude.com/cai/oauth/authorize',
        params: { login_hint: null, login_method: null, orgUUID: null },
      },
      {
        name: '--console goes to the console',
        options: { console: true },
        settings: {},
        authorize: 'https://platform.claude.com/oauth/authorize',
        params: { login_hint: null, login_method: null, orgUUID: null },
      },
      {
        name: '--email and --sso become hints',
        options: { email: 'ada@example.com', sso: true },
        settings: {},
        authorize: 'https://claude.com/cai/oauth/authorize',
        params: { login_hint: 'ada@example.com', login_method: 'sso', orgUUID: null },
      },
      {
        name: 'a forced login method and org beat the flags',
        options: { console: true },
        settings: { forceLoginMethod: 'claudeai', forceLoginOrgUUID: 'org-forced' },
        authorize: 'https://claude.com/cai/oauth/authorize',
        params: { login_hint: null, login_method: null, orgUUID: 'org-forced' },
      },
      {
        name: 'a forced console login beats --claudeai',
        options: { claudeai: true },
        settings: { forceLoginMethod: 'console' },
        authorize: 'https://platform.claude.com/oauth/authorize',
        params: { login_hint: null, login_method: null, orgUUID: null },
      },
    ]
    for (const { name, options, settings, authorize, params } of urlCases) {
      test(`${name}; a refused code exchange fails the login`, async () => {
        writeUserSettings(settings)
        routes[TOKEN] = () => ({ status: 401, data: { error: 'invalid_grant' } })

        await cli(() => authLogin(options))
        const browser = await readBrowser()

        const opened = new URL(browser.opened)
        expect(`${opened.origin}${opened.pathname}`).toBe(authorize)
        expect({
          login_hint: opened.searchParams.get('login_hint'),
          login_method: opened.searchParams.get('login_method'),
          orgUUID: opened.searchParams.get('orgUUID'),
        }).toEqual(params)
        expect(exits).toEqual([1])
        expect(stderr).toStartWith('Login failed: Request failed with status code 401\n')
        expect(stdout).not.toContain('Login successful.')
        // The browser is still sent somewhere rather than left hanging.
        expect(browser.status).toBe(302)
        expect(readCredentials()).toBeNull()
      })
    }
  })
})

// ── authStatus ──────────────────────────────────────────────────────────────

describe('authStatus', () => {
  type Setup = () => void

  const anthropicProfile: Setup = () =>
    setConfig({
      providerProfiles: [
        { id: 'p-ant', name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-profile' },
      ],
      activeProviderProfileId: 'p-ant',
    })
  const openaiProfile: Setup = () =>
    setConfig({
      providerProfiles: [{ id: 'p-oa', name: 'Local', provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'gpt-4o', apiKey: 'k' }],
      activeProviderProfileId: 'p-oa',
    })
  // An unreadable token descriptor makes the key lookup report "none"
  // instead of insisting on a configured key, as it does under NODE_ENV=test.
  const noEnvironmentKey: Setup = () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = 'not-a-descriptor'
    setOauthTokenFromFd(null)
  }
  const claudeAiLogin: Setup = () => {
    noEnvironmentKey()
    writeFileSync(
      credentialsPath(),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-stored', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scopes: SUBSCRIBER_SCOPES, subscriptionType: 'max', rateLimitTier: null },
      }),
    )
    setConfig({
      oauthAccount: { accountUuid: 'acct-1', emailAddress: 'ada@example.com', organizationUuid: 'org-1', organizationName: 'Analytical Engines' },
    })
  }

  const jsonCases: { name: string; setup: Setup; exit: number; json: Record<string, unknown> }[] = [
    {
      name: 'an OAuth token in the environment',
      setup: () => {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'at-env'
      },
      exit: 0,
      json: { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' },
    },
    {
      name: 'an Anthropic profile with a key',
      setup: anthropicProfile,
      exit: 0,
      json: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' },
    },
    {
      name: 'a third-party profile',
      setup: openaiProfile,
      exit: 0,
      json: { loggedIn: true, authMethod: 'third_party', apiProvider: 'openai' },
    },
    {
      name: 'an apiKeyHelper in settings',
      setup: () => {
        noEnvironmentKey()
        writeUserSettings({ apiKeyHelper: 'echo never-run' })
      },
      exit: 0,
      json: { loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' },
    },
    {
      name: 'a stored claude.ai login',
      setup: claudeAiLogin,
      exit: 0,
      json: {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'ada@example.com',
        orgId: 'org-1',
        orgName: 'Analytical Engines',
        subscriptionType: 'max',
      },
    },
    {
      name: 'nothing at all',
      setup: noEnvironmentKey,
      exit: 1,
      json: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
    },
  ]
  for (const { name, setup, exit, json } of jsonCases) {
    test(`JSON for ${name}`, async () => {
      setup()
      await cli(() => authStatus({ json: true }))
      expect(exits).toEqual([exit])
      expect(stdout.endsWith('}\n')).toBe(true)
      expect(JSON.parse(stdout)).toEqual(json)
      // Pretty-printed with two spaces.
      expect(stdout.split('\n')[1]).toStartWith('  "loggedIn": ')
    })
  }

  const textCases: { name: string; setup: Setup; exit: number; text: string }[] = [
    {
      name: 'an OAuth token in the environment',
      setup: () => {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'at-env'
      },
      exit: 0,
      text: 'Auth token: CLAUDE_CODE_OAUTH_TOKEN\n',
    },
    {
      name: 'a stored claude.ai login',
      setup: claudeAiLogin,
      exit: 0,
      text: 'Login method: Claude Max Account\nOrganization: Analytical Engines\nEmail: ada@example.com\n',
    },
    {
      name: 'a Bedrock profile whose auth is skipped',
      setup: () => {
        process.env.AWS_REGION = 'eu-west-1'
        process.env.CLAUDIN_SKIP_BEDROCK_AUTH = '1'
        setConfig({
          providerProfiles: [{ id: 'p-br', name: 'Bedrock', provider: 'bedrock', baseUrl: 'https://bedrock.invalid', model: 'claude-sonnet-4-5' }],
          activeProviderProfileId: 'p-br',
        })
      },
      exit: 0,
      text: 'API provider: AWS Bedrock\nAWS region: eu-west-1\nAWS auth skipped\n',
    },
    {
      name: 'nothing at all',
      setup: noEnvironmentKey,
      exit: 1,
      text: 'Not logged in. Run claude auth login to authenticate.\n',
    },
  ]
  for (const { name, setup, exit, text } of textCases) {
    test(`text for ${name}`, async () => {
      setup()
      await cli(() => authStatus({ text: true }))
      expect(exits).toEqual([exit])
      expect(stdout).toBe(text)
    })
  }
})

// ── authLogout ──────────────────────────────────────────────────────────────

describe('authLogout', () => {
  test('logs out, says so and exits 0', async () => {
    writeFileSync(credentialsPath(), JSON.stringify({ claudeAiOauth: { accessToken: 'old' } }))
    setConfig({ oauthAccount: { accountUuid: 'old', emailAddress: 'old@example.com' }, hasCompletedOnboarding: true })

    await cli(() => authLogout())

    expect(exits).toEqual([0])
    expect(stdout).toBe('Successfully logged out from your Anthropic account.\n')
    expect(stderr).toBe('')
    expect(existsSync(credentialsPath())).toBe(false)
    expect(getGlobalConfig().oauthAccount).toBeUndefined()
    // Logging out is not starting over.
    expect(getGlobalConfig().hasCompletedOnboarding).toBe(true)
  })
})
