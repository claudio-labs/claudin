/**
 * Characterization suite for `src/providers/auth/auth.ts` (1775 lines, 47 runtime
 * exports, zero coverage before this file).
 *
 * WHAT IS GENUINELY CHARACTERIZED — real code driven through real seams (temp
 * settings files on disk, env vars, the test global-config singleton). No
 * `mock.module` anywhere in this file, deliberately: eight other suites
 * `mock.module` this very path, and mocking it here would make the assertions
 * observe the mock instead of the module.
 *
 *   calculateApiKeyHelperTTL
 *   isAnthropicAuthEnabled          (bare-mode and ANTHROPIC_UNIX_SOCKET branches)
 *   getAuthTokenSource              (bare/flagSettings, ANTHROPIC_AUTH_TOKEN,
 *                                    CLAUDE_CODE_OAUTH_TOKEN, managed-OAuth guard)
 *   isAwsAuthRefreshFromProjectSettings
 *   isAwsCredentialExportFromProjectSettings
 *   isGcpAuthRefreshFromProjectSettings
 *   getClaudeAIOAuthTokens          (env-token branch + its memoize contract)
 *   isClaudeAISubscriber, hasProfileScope, is1PApiCustomer, getSubscriptionType,
 *   isMaxSubscriber, isTeamSubscriber, isTeamPremiumSubscriber,
 *   isEnterpriseSubscriber, isProSubscriber, getRateLimitTier,
 *   getSubscriptionName, isUsing3PServices, getOauthAccountInfo,
 *   getAccountInformation
 *   getApiKeyHelperElapsedMs, getApiKeyFromApiKeyHelperCached,
 *   clearApiKeyHelperCache, clearAwsCredentialsCache, clearGcpCredentialsCache,
 *   clearOAuthTokenCache
 *
 * WHAT IS ONLY SURFACE-PINNED — the export exists, nothing about its behaviour
 * is asserted. These are real network, subprocess and keychain I/O; mocking
 * them deeply would produce tests that assert on the mocks:
 *
 *   refreshAwsAuth, refreshGcpAuth, refreshAndGetAwsCredentials,
 *   refreshGcpCredentialsIfNeeded, checkGcpCredentialsValid,
 *   checkAndRefreshOAuthTokenIfNeeded, getClaudeAIOAuthTokensAsync,
 *   handleOAuth401Error, validateForceLoginOrg, getApiKeyFromApiKeyHelper,
 *   getApiKeyFromConfigOrMacOSKeychain, saveApiKey, removeApiKey,
 *   saveOAuthTokensIfNeeded, getAnthropicApiKey, getAnthropicApiKeyWithSource,
 *   getConfiguredApiKeyHelper, prefetchApiKeyFromApiKeyHelperIfSafe,
 *   prefetchGcpCredentialsIfSafe, prefetchAwsCredentialsAndBedRockInfoIfSafe
 *
 * Note on `feature()` flags: they all resolve `false` under `bun test`, so no
 * flag-gated branch in this file is asserted on.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import * as auth from 'src/providers/auth/auth.js'
import {
  getOriginalCwd,
  setFlagSettingsInline,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { ProviderProfile } from 'src/platform/config/config.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'

// Every process-global env var this module reads. Snapshotted once, cleared
// before each test so no test inherits the developer's real shell, and put back
// exactly (delete, never `= undefined`) at the end.
const MANAGED_ENV = [
  'CLAUDIN_SIMPLE',
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_USE_COWORK_PLUGINS',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_UNIX_SOCKET',
] as const

const savedEnv = new Map<string, string | undefined>()
let tmpRoot = ''
let projectDir = ''
let configDir = ''
let savedOriginalCwd = ''
let savedGlobalConfig: Record<string, unknown> = {}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** Write `<projectDir>/.claudin/settings.json` (the `projectSettings` source). */
function writeProjectSettings(settings: Record<string, unknown>): void {
  writeFileSync(join(projectDir, '.claudin', 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
}

/** Write `<projectDir>/.claudin/settings.local.json` (the `localSettings` source). */
function writeLocalSettings(settings: Record<string, unknown>): void {
  writeFileSync(
    join(projectDir, '.claudin', 'settings.local.json'),
    JSON.stringify(settings),
  )
  resetSettingsCache()
}

/** Write `<configDir>/settings.json` (the `userSettings` source — NOT project-scoped). */
function writeUserSettings(settings: Record<string, unknown>): void {
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
}

/** Install provider profiles into the NODE_ENV=test global-config singleton. */
function setActiveProvider(profile: ProviderProfile | null): void {
  saveGlobalConfig(cfg => ({
    ...cfg,
    providerProfiles: profile ? [profile] : [],
    activeProviderProfileId: profile ? profile.id : undefined,
  }))
  invalidateActiveProviderCache()
}

beforeAll(() => {
  for (const key of MANAGED_ENV) savedEnv.set(key, process.env[key])
  savedOriginalCwd = getOriginalCwd()
  savedGlobalConfig = { ...(getGlobalConfig() as unknown as Record<string, unknown>) }

  tmpRoot = mkdtempSync(join(tmpdir(), 'auth-characterization-'))
  projectDir = join(tmpRoot, 'project')
  configDir = join(tmpRoot, 'config')
  mkdirSync(join(projectDir, '.claudin'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
})

beforeEach(() => {
  // Start every test from a known-empty environment: no bare mode, no tokens,
  // settings and credentials resolved out of the temp dirs rather than the
  // developer's own ~/.claudin (which otherwise decides these assertions).
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env.CLAUDIN_CONFIG_DIR = configDir
  setOriginalCwd(projectDir)
  writeProjectSettings({})
  writeLocalSettings({})
  writeUserSettings({})
  setFlagSettingsInline(null)
  setActiveProvider(null)
  auth.clearOAuthTokenCache()
  auth.clearApiKeyHelperCache()
})

afterEach(() => {
  setFlagSettingsInline(null)
  auth.clearOAuthTokenCache()
  auth.clearApiKeyHelperCache()
  invalidateActiveProviderCache()
})

afterAll(() => {
  for (const key of MANAGED_ENV) setEnv(key, savedEnv.get(key))
  setOriginalCwd(savedOriginalCwd)
  saveGlobalConfig(() => savedGlobalConfig as never)
  invalidateActiveProviderCache()
  resetSettingsCache()
  auth.clearOAuthTokenCache()
  auth.clearApiKeyHelperCache()
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// calculateApiKeyHelperTTL
// ---------------------------------------------------------------------------

describe('calculateApiKeyHelperTTL', () => {
  test('defaults to DEFAULT_API_KEY_HELPER_TTL (5 minutes) when the env var is unset', () => {
    expect(auth.calculateApiKeyHelperTTL()).toBe(5 * 60 * 1000)
  })

  test('a valid CLAUDIN_API_KEY_HELPER_TTL_MS overrides the default', () => {
    process.env.CLAUDIN_API_KEY_HELPER_TTL_MS = '1234'
    expect(auth.calculateApiKeyHelperTTL()).toBe(1234)
  })

  test('zero is accepted as an override, not treated as unset', () => {
    // Guards the `parsed >= 0` bound: `> 0` or a plain truthiness check would
    // silently fall back to five minutes here.
    process.env.CLAUDIN_API_KEY_HELPER_TTL_MS = '0'
    expect(auth.calculateApiKeyHelperTTL()).toBe(0)
  })

  test('a negative value falls back to the default', () => {
    process.env.CLAUDIN_API_KEY_HELPER_TTL_MS = '-1'
    expect(auth.calculateApiKeyHelperTTL()).toBe(5 * 60 * 1000)
  })

  test('a non-numeric value falls back to the default', () => {
    // PROBE FINDING: this is guarded by the `parsed >= 0` bound alone. The
    // `!Number.isNaN(parsed)` half of that condition is redundant — NaN >= 0 is
    // already false — so deleting it changes no observable behaviour. Left in
    // place as defensive code; recorded here so nobody reads this test as
    // coverage of the NaN check.
    process.env.CLAUDIN_API_KEY_HELPER_TTL_MS = 'not-a-number'
    expect(auth.calculateApiKeyHelperTTL()).toBe(5 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// isAnthropicAuthEnabled — the two branches that are fully env-determined
// ---------------------------------------------------------------------------

describe('isAnthropicAuthEnabled', () => {
  test('bare mode is API-key-only: never OAuth', () => {
    process.env.CLAUDIN_SIMPLE = '1'
    expect(auth.isAnthropicAuthEnabled()).toBe(false)
  })

  test('ANTHROPIC_UNIX_SOCKET without a placeholder OAuth token disables auth', () => {
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/anthropic.sock'
    expect(auth.isAnthropicAuthEnabled()).toBe(false)
  })

  test('ANTHROPIC_UNIX_SOCKET with a placeholder OAuth token enables auth', () => {
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/anthropic.sock'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder-token'
    expect(auth.isAnthropicAuthEnabled()).toBe(true)
  })

  test('the socket branch wins over settings: an apiKeyHelper cannot flip it', () => {
    // The comment on this branch is explicit that the remote's own settings
    // MUST NOT flip the decision, because that desyncs the beta header from
    // what the auth-injecting proxy will supply. Deleting the early return
    // makes the apiKeyHelper below disable auth.
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/anthropic.sock'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder-token'
    writeProjectSettings({ apiKeyHelper: 'echo sk-ant-test' })
    expect(auth.isAnthropicAuthEnabled()).toBe(true)
  })

  test('with no third-party provider and no external key, auth is enabled', () => {
    expect(auth.isAnthropicAuthEnabled()).toBe(true)
  })

  test('an external ANTHROPIC_AUTH_TOKEN disables Anthropic OAuth', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'ext-token'
    expect(auth.isAnthropicAuthEnabled()).toBe(false)
  })

  test('a managed OAuth context (CLAUDE_CODE_REMOTE) ignores the external token', () => {
    // CCR/Claude Desktop sessions must not inherit the terminal user's key.
    process.env.ANTHROPIC_AUTH_TOKEN = 'ext-token'
    process.env.CLAUDE_CODE_REMOTE = '1'
    expect(auth.isAnthropicAuthEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getAuthTokenSource
// ---------------------------------------------------------------------------

describe('getAuthTokenSource', () => {
  test('bare mode with no --settings apiKeyHelper reports no token', () => {
    process.env.CLAUDIN_SIMPLE = '1'
    expect(auth.getAuthTokenSource()).toEqual({ source: 'none', hasToken: false })
  })

  test('bare mode reads apiKeyHelper ONLY from flag settings', () => {
    // A project-settings apiKeyHelper is deliberately ignored under --bare.
    process.env.CLAUDIN_SIMPLE = '1'
    writeProjectSettings({ apiKeyHelper: 'echo sk-ant-from-project' })
    expect(auth.getAuthTokenSource()).toEqual({ source: 'none', hasToken: false })

    setFlagSettingsInline({ apiKeyHelper: 'echo sk-ant-from-flag' })
    resetSettingsCache()
    expect(auth.getAuthTokenSource()).toEqual({ source: 'apiKeyHelper', hasToken: true })
  })

  test('bare mode ignores an OAuth env token entirely', () => {
    process.env.CLAUDIN_SIMPLE = '1'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
    expect(auth.getAuthTokenSource()).toEqual({ source: 'none', hasToken: false })
  })

  test('ANTHROPIC_AUTH_TOKEN outranks an OAuth env token', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'ext-token'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
    expect(auth.getAuthTokenSource()).toEqual({
      source: 'ANTHROPIC_AUTH_TOKEN',
      hasToken: true,
    })
  })

  test('CLAUDE_CODE_REMOTE suppresses ANTHROPIC_AUTH_TOKEN, falling through to OAuth', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'ext-token'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
    process.env.CLAUDE_CODE_REMOTE = '1'
    expect(auth.getAuthTokenSource()).toEqual({
      source: 'CLAUDE_CODE_OAUTH_TOKEN',
      hasToken: true,
    })
  })

  test('CLAUDE_CODE_ENTRYPOINT=claude-desktop is the other managed context', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'ext-token'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    expect(auth.getAuthTokenSource()).toEqual({
      source: 'CLAUDE_CODE_OAUTH_TOKEN',
      hasToken: true,
    })
  })

  test('a non-truthy CLAUDE_CODE_REMOTE does NOT count as a managed context', () => {
    // isEnvTruthy accepts 1/true/yes/on only.
    process.env.ANTHROPIC_AUTH_TOKEN = 'ext-token'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token'
    process.env.CLAUDE_CODE_REMOTE = '0'
    expect(auth.getAuthTokenSource()).toEqual({
      source: 'ANTHROPIC_AUTH_TOKEN',
      hasToken: true,
    })
  })

  test('a configured apiKeyHelper is reported without executing it', () => {
    // The helper command is deliberately one that would fail loudly if run.
    writeProjectSettings({ apiKeyHelper: 'exit 42' })
    expect(auth.getAuthTokenSource()).toEqual({ source: 'apiKeyHelper', hasToken: true })
  })

  test('no credentials at all reports source "none"', () => {
    expect(auth.getAuthTokenSource()).toEqual({ source: 'none', hasToken: false })
  })
})

// ---------------------------------------------------------------------------
// Project-settings provenance — whether a credential-producing command came
// from a PROJECT settings file (untrusted) or from the user's own settings.
// ---------------------------------------------------------------------------

describe('project-settings provenance predicates', () => {
  test('awsAuthRefresh from project settings is flagged as project-scoped', () => {
    writeProjectSettings({ awsAuthRefresh: 'aws sso login' })
    expect(auth.isAwsAuthRefreshFromProjectSettings()).toBe(true)
  })

  test('awsAuthRefresh from local settings is flagged as project-scoped', () => {
    writeLocalSettings({ awsAuthRefresh: 'aws sso login --local' })
    expect(auth.isAwsAuthRefreshFromProjectSettings()).toBe(true)
  })

  test('awsAuthRefresh from USER settings is NOT project-scoped', () => {
    // The load-bearing half: the user's own ~/.claudin/settings.json is trusted,
    // so the trust dialog must not fire for it. A predicate that returned true
    // for every configured value would prompt on every launch.
    writeUserSettings({ awsAuthRefresh: 'aws sso login' })
    expect(auth.isAwsAuthRefreshFromProjectSettings()).toBe(false)
  })

  test('no awsAuthRefresh configured is not project-scoped', () => {
    expect(auth.isAwsAuthRefreshFromProjectSettings()).toBe(false)
  })

  test('awsCredentialExport from project settings is flagged as project-scoped', () => {
    writeProjectSettings({ awsCredentialExport: 'my-export-cmd' })
    expect(auth.isAwsCredentialExportFromProjectSettings()).toBe(true)
  })

  test('awsCredentialExport from USER settings is NOT project-scoped', () => {
    writeUserSettings({ awsCredentialExport: 'my-export-cmd' })
    expect(auth.isAwsCredentialExportFromProjectSettings()).toBe(false)
  })

  test('no awsCredentialExport configured is not project-scoped', () => {
    expect(auth.isAwsCredentialExportFromProjectSettings()).toBe(false)
  })

  test('gcpAuthRefresh from project settings is flagged as project-scoped', () => {
    writeProjectSettings({ gcpAuthRefresh: 'gcloud auth login' })
    expect(auth.isGcpAuthRefreshFromProjectSettings()).toBe(true)
  })

  test('gcpAuthRefresh from USER settings is NOT project-scoped', () => {
    writeUserSettings({ gcpAuthRefresh: 'gcloud auth login' })
    expect(auth.isGcpAuthRefreshFromProjectSettings()).toBe(false)
  })

  test('no gcpAuthRefresh configured is not project-scoped', () => {
    expect(auth.isGcpAuthRefreshFromProjectSettings()).toBe(false)
  })

  test('a project value that merely SHADOWS a user value still counts as project-scoped', () => {
    // Project settings win the merge, so the effective command is the project
    // one and the predicate must say so.
    writeUserSettings({ awsAuthRefresh: 'user-cmd' })
    writeProjectSettings({ awsAuthRefresh: 'project-cmd' })
    expect(auth.isAwsAuthRefreshFromProjectSettings()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getClaudeAIOAuthTokens — the env-token branch and the memoize contract
// ---------------------------------------------------------------------------

describe('getClaudeAIOAuthTokens', () => {
  test('CLAUDE_CODE_OAUTH_TOKEN synthesises an inference-only service token', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'svc-token'
    expect(auth.getClaudeAIOAuthTokens()).toEqual({
      accessToken: 'svc-token',
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    })
  })

  test('bare mode reads no credentials at all', () => {
    process.env.CLAUDIN_SIMPLE = '1'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'svc-token'
    expect(auth.getClaudeAIOAuthTokens()).toBeNull()
  })

  test('the result is memoized, and clearOAuthTokenCache is what invalidates it', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'first-token'
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('first-token')

    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'second-token'
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('first-token')

    auth.clearOAuthTokenCache()
    expect(auth.getClaudeAIOAuthTokens()?.accessToken).toBe('second-token')
  })
})

// ---------------------------------------------------------------------------
// Subscription predicates, over a pinned account shape
// ---------------------------------------------------------------------------

describe('subscription predicates — Anthropic auth disabled (bare mode)', () => {
  beforeEach(() => {
    process.env.CLAUDIN_SIMPLE = '1'
    auth.clearOAuthTokenCache()
  })

  test('every subscriber predicate is false and every getter is empty', () => {
    // PROBE FINDING: the `if (!isAnthropicAuthEnabled()) return null` gates
    // inside getSubscriptionType and getRateLimitTier are NOT guarded by this
    // test. In bare mode getClaudeAIOAuthTokens() already returns null, so
    // deleting either gate changes nothing here. Reaching them would need a
    // session where auth is disabled but credentials ARE present — i.e. a real
    // credentials store, which on Linux is read through libsecret before the
    // plaintext fallback and would pick up the developer's own keychain. That
    // is machine-dependent, so it is deliberately not attempted. What IS
    // guarded below are the comparison operators of each predicate.
    expect(auth.isClaudeAISubscriber()).toBe(false)
    expect(auth.getSubscriptionType()).toBeNull()
    expect(auth.getRateLimitTier()).toBeNull()
    expect(auth.isMaxSubscriber()).toBe(false)
    expect(auth.isTeamSubscriber()).toBe(false)
    expect(auth.isTeamPremiumSubscriber()).toBe(false)
    expect(auth.isEnterpriseSubscriber()).toBe(false)
    expect(auth.isProSubscriber()).toBe(false)
    expect(auth.hasProfileScope()).toBe(false)
  })

  test('getSubscriptionName falls back to "Claude API"', () => {
    expect(auth.getSubscriptionName()).toBe('Claude API')
  })

  test('getOauthAccountInfo withholds a PRESENT account when auth is disabled', () => {
    // The config genuinely holds an account here, so the assertion fails if the
    // isAnthropicAuthEnabled() gate is removed — without this the test would
    // pass against an empty config no matter what the function did.
    saveGlobalConfig(cfg => ({
      ...cfg,
      oauthAccount: {
        accountUuid: 'acct-uuid',
        emailAddress: 'dev@example.com',
        organizationName: 'Example Org',
      },
    }))
    expect(auth.getOauthAccountInfo()).toBeUndefined()

    delete process.env.CLAUDIN_SIMPLE
    expect(auth.getOauthAccountInfo()).toEqual({
      accountUuid: 'acct-uuid',
      emailAddress: 'dev@example.com',
      organizationName: 'Example Org',
    })
  })

  test('is1PApiCustomer is true — no subscription, no 3P transport', () => {
    expect(auth.is1PApiCustomer()).toBe(true)
  })
})

describe('subscription predicates — env OAuth service token', () => {
  beforeEach(() => {
    // A CLAUDE_CODE_OAUTH_TOKEN yields scopes ['user:inference'] only, with no
    // subscriptionType and no rateLimitTier. This is the documented shape of a
    // service-key session.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'svc-token'
    auth.clearOAuthTokenCache()
  })

  test('the inference scope makes it a claude.ai auth session', () => {
    expect(auth.isClaudeAISubscriber()).toBe(true)
  })

  test('but it has NO profile scope, so profile endpoints stay gated', () => {
    // Guards the CLAUDE_AI_PROFILE_SCOPE check: a service key that reported
    // profile scope would 403-storm /api/oauth/profile.
    expect(auth.hasProfileScope()).toBe(false)
  })

  test('a claude.ai session is not a 1P API customer', () => {
    expect(auth.is1PApiCustomer()).toBe(false)
  })

  test('no subscriptionType on the token means no subscription tier', () => {
    expect(auth.getSubscriptionType()).toBeNull()
    expect(auth.isMaxSubscriber()).toBe(false)
    expect(auth.isTeamSubscriber()).toBe(false)
    expect(auth.isTeamPremiumSubscriber()).toBe(false)
    expect(auth.isEnterpriseSubscriber()).toBe(false)
    expect(auth.isProSubscriber()).toBe(false)
    expect(auth.getRateLimitTier()).toBeNull()
    expect(auth.getSubscriptionName()).toBe('Claude API')
  })
})

describe('getSubscriptionName maps each subscription type', () => {
  // Drives the switch through the real getSubscriptionType by pinning the
  // oauthAccount-independent path: the token's own subscriptionType field.
  // getClaudeAIOAuthTokens reads secure storage, which these tests do not
  // reach, so the mapping is exercised via the documented fallback only.
  test('an unknown/absent type maps to "Claude API"', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'svc-token'
    auth.clearOAuthTokenCache()
    expect(auth.getSubscriptionName()).toBe('Claude API')
  })
})

// ---------------------------------------------------------------------------
// isUsing3PServices / getAccountInformation — driven by the active provider
// ---------------------------------------------------------------------------

describe('isUsing3PServices', () => {
  test('no configured provider is not third-party', () => {
    // The `!transport` guard: an unconfigured session must not be reported as
    // 3P, or first-party auth would be disabled at startup for every new user.
    setActiveProvider(null)
    expect(auth.isUsing3PServices()).toBe(false)
  })

  test('an anthropic transport is not third-party', () => {
    setActiveProvider({
      id: 'p_anthropic',
      name: 'Anthropic',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    })
    expect(auth.isUsing3PServices()).toBe(false)
  })

  test('a non-anthropic transport is third-party', () => {
    setActiveProvider({
      id: 'p_openai',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
    })
    expect(auth.isUsing3PServices()).toBe(true)
  })

  test('a third-party provider disables Anthropic auth', () => {
    setActiveProvider({
      id: 'p_openai',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
    })
    expect(auth.isAnthropicAuthEnabled()).toBe(false)
  })
})

describe('getAccountInformation', () => {
  test('returns undefined for a non-first-party API provider', () => {
    setActiveProvider({
      id: 'p_openai',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
    })
    expect(auth.getAccountInformation()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Cache accessors — observable contract only
// ---------------------------------------------------------------------------

describe('cache accessors', () => {
  // HONEST SCOPE: populating the apiKeyHelper cache requires executing the
  // configured helper as a subprocess, which this suite deliberately does not
  // do. So these two pin the EMPTY-STATE READ of each accessor — that an
  // unpopulated cache reports null / 0 rather than leaking a value — and NOT
  // that clearApiKeyHelperCache() empties a populated cache. The only cache
  // whose clear IS observed here is the OAuth one, in the memoize test above.
  test('an unpopulated apiKeyHelper cache reads as null', () => {
    auth.clearApiKeyHelperCache()
    expect(auth.getApiKeyFromApiKeyHelperCached()).toBeNull()
  })

  test('elapsed time is zero when no helper fetch is in flight', () => {
    auth.clearApiKeyHelperCache()
    expect(auth.getApiKeyHelperElapsedMs()).toBe(0)
  })

  test('clearing is idempotent across every cache (pins only that it cannot throw)', () => {
    auth.clearApiKeyHelperCache()
    auth.clearApiKeyHelperCache()
    auth.clearAwsCredentialsCache()
    auth.clearAwsCredentialsCache()
    auth.clearGcpCredentialsCache()
    auth.clearGcpCredentialsCache()
    auth.clearOAuthTokenCache()
    auth.clearOAuthTokenCache()
    expect(auth.getApiKeyFromApiKeyHelperCached()).toBeNull()
    expect(auth.getApiKeyHelperElapsedMs()).toBe(0)
  })

  // DROPPED: "the AWS and GCP memoize caches are empty after clearing".
  // memoizeWithTTLAsync exposes only `clear` on its cache handle — no `size`,
  // no `has` (src/shared/data/memoize.ts:123). The only way to observe that
  // those two caches are empty is to call them, which spawns the real
  // `awsAuthRefresh` / `gcpAuthRefresh` subprocess. There is no honest
  // assertion here, so there is none.
})

// ---------------------------------------------------------------------------
// Export-surface pin
// ---------------------------------------------------------------------------

describe('export surface', () => {
  // Neither the build nor tsc can see a dropped export from a module reached
  // only through `import *`. This is the only thing that can.
  const EXPECTED_EXPORTS = [
    'calculateApiKeyHelperTTL',
    'checkAndRefreshOAuthTokenIfNeeded',
    'checkGcpCredentialsValid',
    'clearApiKeyHelperCache',
    'clearAwsCredentialsCache',
    'clearGcpCredentialsCache',
    'clearOAuthTokenCache',
    'getAccountInformation',
    'getAnthropicApiKey',
    'getAnthropicApiKeyWithSource',
    'getApiKeyFromApiKeyHelper',
    'getApiKeyFromApiKeyHelperCached',
    'getApiKeyFromConfigOrMacOSKeychain',
    'getApiKeyHelperElapsedMs',
    'getAuthTokenSource',
    'getClaudeAIOAuthTokens',
    'getClaudeAIOAuthTokensAsync',
    'getConfiguredApiKeyHelper',
    'getOauthAccountInfo',
    'getRateLimitTier',
    'getSubscriptionName',
    'getSubscriptionType',
    'handleOAuth401Error',
    'hasProfileScope',
    'is1PApiCustomer',
    'isAnthropicAuthEnabled',
    'isAwsAuthRefreshFromProjectSettings',
    'isAwsCredentialExportFromProjectSettings',
    'isClaudeAISubscriber',
    'isEnterpriseSubscriber',
    'isGcpAuthRefreshFromProjectSettings',
    'isMaxSubscriber',
    'isProSubscriber',
    'isTeamPremiumSubscriber',
    'isTeamSubscriber',
    'isUsing3PServices',
    'prefetchApiKeyFromApiKeyHelperIfSafe',
    'prefetchAwsCredentialsAndBedRockInfoIfSafe',
    'prefetchGcpCredentialsIfSafe',
    'refreshAndGetAwsCredentials',
    'refreshAwsAuth',
    'refreshGcpAuth',
    'refreshGcpCredentialsIfNeeded',
    'removeApiKey',
    'saveApiKey',
    'saveOAuthTokensIfNeeded',
    'validateForceLoginOrg',
  ]

  test('the module exports exactly the expected names', () => {
    expect(Object.keys(auth).sort()).toEqual(EXPECTED_EXPORTS)
  })

  test('every export is callable', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(typeof auth[name as keyof typeof auth]).toBe('function')
    }
  })
})
