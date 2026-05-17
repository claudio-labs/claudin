import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const originalEnv = { ...process.env }
// Capture real envUtils at module load — used inside installCommonMocks()
// to spread the full namespace shape into the partial mock, preventing
// cross-file leaks of missing exports. Spread into snapshots so afterAll
// restores see the original bindings, not a later mock factory's exports.
const realEnvUtilsForFastMode = { ...(await import('./envUtils.js')) }
const realConfigForFastMode = { ...(await import('./config.js')) }
const realAuthForFastMode = { ...(await import('./auth.js')) }
const realDebugForFastMode = { ...(await import('./debug.js')) }
const realBootstrapStateForFastMode = { ...(await import('../bootstrap/state.js')) }
const realAnalyticsForFastMode = { ...(await import('../services/analytics/index.js')) }
const realGrowthbookForFastMode = { ...(await import('../services/analytics/growthbook.js')) }
const realBundledModeForFastMode = { ...(await import('./bundledMode.js')) }
const realModelForFastMode = { ...(await import('./model/model.js')) }
const realProvidersForFastMode = { ...(await import('./model/providers.js')) }
const realPrivacyLevelForFastMode = { ...(await import('./privacyLevel.js')) }
const realSettingsForFastMode = { ...(await import('./settings/settings.js')) }
const realSignalForFastMode = { ...(await import('./signal.js')) }

async function importFreshFastModeModule() {
  return import(`./fastMode.ts?ts=${Date.now()}-${Math.random()}`)
}

function installCommonMocks(options?: {
  cachedEnabled?: boolean
  apiKey?: string | null
  oauthToken?: string | null
  hasProfileScope?: boolean
  axiosReject?: boolean
}) {
  mock.module('axios', () => ({
    default: {
      get: options?.axiosReject
        ? async () => {
            throw new Error('network fail')
          }
        : async () => ({ data: { enabled: false, disabled_reason: 'preference' } }),
      isAxiosError: () => false,
    },
  }))

  mock.module('src/constants/oauth.js', () => ({
    getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
    OAUTH_BETA_HEADER: 'test-beta',
  }))

  mock.module('src/services/analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: (_name: string, defaultValue: unknown) =>
      defaultValue,
  }))

  mock.module('../bootstrap/state.js', () => ({
    getIsNonInteractiveSession: () => false,
    getKairosActive: () => false,
    preferThirdPartyAuthentication: () => false,
  }))

  mock.module('../services/analytics/index.js', () => ({
    logEvent: () => {},
  }))

  mock.module('./auth.js', () => ({
    getAnthropicApiKey: () => options?.apiKey ?? null,
    getClaudeAIOAuthTokens: () =>
      options?.oauthToken ? { accessToken: options.oauthToken } : null,
    handleOAuth401Error: async () => {},
    hasProfileScope: () => options?.hasProfileScope ?? false,
  }))

  mock.module('./bundledMode.js', () => ({
    isInBundledMode: () => true,
  }))

  mock.module('./config.js', () => ({
    ...realConfigForFastMode,
    getGlobalConfig: () => ({
      penguinModeOrgEnabled: options?.cachedEnabled === true,
    }),
    saveGlobalConfig: (updater: (current: Record<string, unknown>) => Record<string, unknown>) =>
      updater({ penguinModeOrgEnabled: options?.cachedEnabled === true }),
  }))

  mock.module('./debug.js', () => ({
    logForDebugging: () => {},
  }))

  mock.module('./envUtils.js', () => ({
    ...realEnvUtilsForFastMode,
    isEnvTruthy: (value: string | undefined) =>
      !!value && value !== '0' && value.toLowerCase() !== 'false',
  }))

  mock.module('./model/model.js', () => ({
    getDefaultMainLoopModelSetting: () => 'claude-sonnet-4-6',
    isOpus1mMergeEnabled: () => false,
    parseUserSpecifiedModel: (model: string) => model,
  }))

  mock.module('./model/providers.js', () => ({
    getAPIProvider: () => 'firstParty',
  }))

  mock.module('./privacyLevel.js', () => ({
    isEssentialTrafficOnly: () => false,
  }))

  mock.module('./settings/settings.js', () => ({
    getInitialSettings: () => ({ fastMode: true }),
    getSettingsForSource: () => ({}),
    updateSettingsForSource: () => {},
  }))

  mock.module('./signal.js', () => ({
    createSignal: () => {
      const subscribe = () => () => {}
      const emit = () => {}
      return { subscribe, emit }
    },
  }))
}

afterEach(() => {
  process.env = { ...originalEnv }
})

// Re-pin every mocked module to its captured real namespace. Bun's
// `mock.module` is process-global and `mock.restore()` does not undo it, so
// without this every later test file inherits this file's stubs (notably the
// `./config.js` partial that breaks `toolResultSummarizer.*.test.ts`).
afterAll(() => {
  mock.module('./config.js', () => realConfigForFastMode)
  mock.module('./envUtils.js', () => realEnvUtilsForFastMode)
  mock.module('./auth.js', () => realAuthForFastMode)
  mock.module('./debug.js', () => realDebugForFastMode)
  mock.module('../bootstrap/state.js', () => realBootstrapStateForFastMode)
  mock.module('../services/analytics/index.js', () => realAnalyticsForFastMode)
  mock.module('../services/analytics/growthbook.js', () => realGrowthbookForFastMode)
  mock.module('./bundledMode.js', () => realBundledModeForFastMode)
  mock.module('./model/model.js', () => realModelForFastMode)
  mock.module('./model/providers.js', () => realProvidersForFastMode)
  mock.module('./privacyLevel.js', () => realPrivacyLevelForFastMode)
  mock.module('./settings/settings.js', () => realSettingsForFastMode)
  mock.module('./signal.js', () => realSignalForFastMode)
  realConfigForFastMode.resetGlobalConfigForTests?.()
})

describe('fastMode ant-only fallback cleanup', () => {
  test('resolveFastModeStatusFromCache does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    installCommonMocks({ cachedEnabled: false })

    const {
      resolveFastModeStatusFromCache,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()

    resolveFastModeStatusFromCache()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode is currently unavailable',
    )
  })

  test('prefetchFastModeStatus without auth does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    installCommonMocks({ cachedEnabled: false, apiKey: null, oauthToken: null })

    const {
      prefetchFastModeStatus,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()

    await prefetchFastModeStatus()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode has been disabled by your organization',
    )
  })

  test('prefetchFastModeStatus network failure does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    installCommonMocks({
      cachedEnabled: false,
      apiKey: 'test-key',
      axiosReject: true,
    })

    const {
      prefetchFastModeStatus,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()

    await prefetchFastModeStatus()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode unavailable due to network connectivity issues',
    )
  })
})
