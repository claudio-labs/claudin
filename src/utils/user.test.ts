import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const originalEnv = { ...process.env }
// Capture real envUtils at module load — used inside installCommonMocks()
// to spread the full namespace shape into the partial mock, preventing
// cross-file leaks of missing exports. Spread into snapshots so afterAll
// restores see the original bindings, not a later mock factory's exports.
const realEnvUtilsForUserTest = { ...(await import('./envUtils.js')) }
const realConfigForUserTest = { ...(await import('./config.js')) }
const realAuthForUserTest = { ...(await import('./auth.js')) }
const realBootstrapStateForUserTest = { ...(await import('../bootstrap/state.js')) }
const realCwdForUserTest = { ...(await import('./cwd.js')) }
const realEnvForUserTest = { ...(await import('./env.js')) }

async function importFreshUserModule() {
  return import(`./user.ts?ts=${Date.now()}-${Math.random()}`)
}

function installCommonMocks(options?: {
  oauthEmail?: string
  gitEmail?: string
}) {
  mock.module('../bootstrap/state.js', () => ({
    getSessionId: () => 'session-test',
  }))

  mock.module('./auth.js', () => ({
    getOauthAccountInfo: () =>
      options?.oauthEmail
        ? {
            emailAddress: options.oauthEmail,
            organizationUuid: 'org-test',
            accountUuid: 'acct-test',
          }
        : undefined,
    getRateLimitTier: () => null,
    getSubscriptionType: () => null,
  }))

  mock.module('./config.js', () => ({
    ...realConfigForUserTest,
    getGlobalConfig: () => ({}),
    getOrCreateUserID: () => 'device-test',
  }))

  mock.module('./cwd.js', () => ({
    getCwd: () => 'C:\\repo',
  }))

  mock.module('./env.js', () => ({
    ...realEnvForUserTest,
    env: { platform: 'windows' },
    getHostPlatformForAnalytics: () => 'windows',
  }))

  mock.module('./envUtils.js', () => ({
    ...realEnvUtilsForUserTest,
    isEnvTruthy: (value: string | undefined) =>
      !!value && value !== '0' && value.toLowerCase() !== 'false',
  }))

  mock.module('execa', () => ({
    execa: async () => ({
      exitCode: options?.gitEmail ? 0 : 1,
      stdout: options?.gitEmail ?? '',
    }),
  }))
}

afterEach(() => {
  process.env = { ...originalEnv }
  delete (globalThis as Record<string, unknown>).MACRO
})

// Re-pin every mocked module to its captured real namespace. Bun's
// `mock.module` is process-global and `mock.restore()` does not undo it, so
// without this every later test file inherits this file's stubs.
afterAll(() => {
  mock.module('./config.js', () => realConfigForUserTest)
  mock.module('./envUtils.js', () => realEnvUtilsForUserTest)
  mock.module('./auth.js', () => realAuthForUserTest)
  mock.module('../bootstrap/state.js', () => realBootstrapStateForUserTest)
  mock.module('./cwd.js', () => realCwdForUserTest)
  mock.module('./env.js', () => realEnvForUserTest)
})

describe('user email fallbacks', () => {
  test('getCoreUserData does not synthesize Anthropic email from COO_CREATOR', async () => {
    process.env.USER_TYPE = 'ant'
    process.env.COO_CREATOR = 'alice'
    ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

    installCommonMocks()

    const { getCoreUserData } = await importFreshUserModule()
    const result = getCoreUserData()

    expect(result.email).toBeUndefined()
  })

  test('initUser falls back to git email when oauth email is missing', async () => {
    process.env.USER_TYPE = 'ant'
    process.env.COO_CREATOR = 'alice'
    ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

    installCommonMocks({ gitEmail: 'git@example.com' })

    const { initUser, getCoreUserData } = await importFreshUserModule()
    await initUser()

    const result = getCoreUserData()
    expect(result.email).toBe('git@example.com')
  })
})
