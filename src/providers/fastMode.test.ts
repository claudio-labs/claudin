import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const originalEnv = { ...process.env }
// Capture real envUtils at module load — used inside installCommonMocks()
// to spread the full namespace shape into the partial mock, preventing
// cross-file leaks of missing exports. Spread into snapshots so afterAll
// restores see the original bindings, not a later mock factory's exports.
const realEnvUtilsForFastMode = { ...(await import('src/shared/envUtils.js')) }
const realConfigForFastMode = { ...(await import('src/platform/config/config.js')) }
const realAuthForFastMode = { ...(await import('src/providers/auth/auth.js')) }
const realDebugForFastMode = { ...(await import('src/shared/debug.js')) }
const realBootstrapStateForFastMode = { ...(await import('src/platform/bootstrap/state.js')) }
const realAnalyticsForFastMode = { ...(await import('src/platform/analytics/index.js')) }
const realGrowthbookForFastMode = { ...(await import('src/platform/analytics/growthbook.js')) }
const realBundledModeForFastMode = { ...(await import('src/platform/install/bundledMode.js')) }
const realModelForFastMode = { ...(await import('src/providers/model/model.js')) }
const realProvidersForFastMode = { ...(await import('src/providers/model/providers.js')) }
const realPrivacyLevelForFastMode = { ...(await import('src/platform/config/privacyLevel.js')) }
const realSettingsForFastMode = { ...(await import('src/platform/settings/settings.js')) }
const realSignalForFastMode = { ...(await import('src/shared/signal.js')) }

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

  mock.module('src/shared/constants/oauth.js', () => ({
    getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
    OAUTH_BETA_HEADER: 'test-beta',
  }))

  mock.module('src/platform/analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: (_name: string, defaultValue: unknown) =>
      defaultValue,
  }))

  mock.module('src/platform/bootstrap/state.js', () => ({
    getIsNonInteractiveSession: () => false,
    getKairosActive: () => false,
    preferThirdPartyAuthentication: () => false,
  }))

  mock.module('src/platform/analytics/index.js', () => ({
    logEvent: () => {},
  }))

  mock.module('src/providers/auth/auth.js', () => ({
    getAnthropicApiKey: () => options?.apiKey ?? null,
    getClaudeAIOAuthTokens: () =>
      options?.oauthToken ? { accessToken: options.oauthToken } : null,
    handleOAuth401Error: async () => {},
    hasProfileScope: () => options?.hasProfileScope ?? false,
  }))

  mock.module('src/platform/install/bundledMode.js', () => ({
    isInBundledMode: () => true,
  }))

  mock.module('src/platform/config/config.js', () => ({
    ...realConfigForFastMode,
    getGlobalConfig: () => ({
      penguinModeOrgEnabled: options?.cachedEnabled === true,
    }),
    saveGlobalConfig: (updater: (current: Record<string, unknown>) => Record<string, unknown>) =>
      updater({ penguinModeOrgEnabled: options?.cachedEnabled === true }),
  }))

  mock.module('src/shared/debug.js', () => ({
    logForDebugging: () => {},
  }))

  mock.module('src/shared/envUtils.js', () => ({
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

  mock.module('src/platform/config/privacyLevel.js', () => ({
    isEssentialTrafficOnly: () => false,
  }))

  mock.module('src/platform/settings/settings.js', () => ({
    getInitialSettings: () => ({ fastMode: true }),
    getSettingsForSource: () => ({}),
    updateSettingsForSource: () => {},
  }))

  mock.module('src/shared/signal.js', () => ({
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
  mock.module('src/platform/config/config.js', () => realConfigForFastMode)
  mock.module('src/shared/envUtils.js', () => realEnvUtilsForFastMode)
  mock.module('src/providers/auth/auth.js', () => realAuthForFastMode)
  mock.module('src/shared/debug.js', () => realDebugForFastMode)
  mock.module('src/platform/bootstrap/state.js', () => realBootstrapStateForFastMode)
  mock.module('src/platform/analytics/index.js', () => realAnalyticsForFastMode)
  mock.module('src/platform/analytics/growthbook.js', () => realGrowthbookForFastMode)
  mock.module('src/platform/install/bundledMode.js', () => realBundledModeForFastMode)
  mock.module('./model/model.js', () => realModelForFastMode)
  mock.module('./model/providers.js', () => realProvidersForFastMode)
  mock.module('src/platform/config/privacyLevel.js', () => realPrivacyLevelForFastMode)
  mock.module('src/platform/settings/settings.js', () => realSettingsForFastMode)
  mock.module('src/shared/signal.js', () => realSignalForFastMode)
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
