import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

import type { AppState } from './AppStateStore.js'
import { getEmptyToolPermissionContext } from '../Tool.js'

// These tests verify the `suppressNextMainLoopModelPersist` contract used by
// ProviderManager flows (edit-active-profile-while-override-active,
// delete-active-profile-while-override-active, clear-override). They exercise
// `onChangeAppState` directly with mocked persistence boundaries.

const realConfig = { ...(await import('../utils/config.js')) }
const realProviderProfiles = {
  ...(await import('../utils/providerProfiles.js')),
}
const realSettings = { ...(await import('../utils/settings/settings.js')) }
const realSessionState = { ...(await import('../utils/sessionState.js')) }
const realAuth = { ...(await import('../utils/auth.js')) }
const realManagedEnv = { ...(await import('../utils/managedEnv.js')) }
const realBootstrapState = { ...(await import('../bootstrap/state.js')) }

let hasOverride = false
let validatedOverrideId: string | undefined
let saveCurrentProjectConfigCalls: number
let updateSettingsForSourceCalls: number
let persistActiveProviderProfileModelCalls: number
let setMainLoopModelOverrideCalls: Array<unknown>

function installMocks(): void {
  mock.module('../utils/config.js', () => ({
    ...realConfig,
    getGlobalConfig: () => ({}),
    saveGlobalConfig: () => {},
    saveCurrentProjectConfig: () => {
      saveCurrentProjectConfigCalls += 1
    },
  }))
  mock.module('../utils/providerProfiles.js', () => ({
    ...realProviderProfiles,
    hasProjectProviderProfileOverride: () => hasOverride,
    getProjectActiveProviderProfileId: () => validatedOverrideId,
    persistActiveProviderProfileModel: () => {
      persistActiveProviderProfileModelCalls += 1
    },
    clearActiveProviderProfileModel: () => {},
  }))
  mock.module('../utils/settings/settings.js', () => ({
    ...realSettings,
    updateSettingsForSource: () => {
      updateSettingsForSourceCalls += 1
    },
  }))
  mock.module('../utils/sessionState.js', () => ({
    ...realSessionState,
    notifySessionMetadataChanged: () => {},
    notifyPermissionModeChanged: () => {},
  }))
  mock.module('../utils/auth.js', () => ({
    ...realAuth,
    clearApiKeyHelperCache: () => {},
    clearAwsCredentialsCache: () => {},
    clearGcpCredentialsCache: () => {},
  }))
  mock.module('../utils/managedEnv.js', () => ({
    ...realManagedEnv,
    applyConfigEnvironmentVariables: () => {},
  }))
  mock.module('../bootstrap/state.js', () => ({
    ...realBootstrapState,
    setMainLoopModelOverride: (value: unknown) => {
      setMainLoopModelOverrideCalls.push(value)
    },
  }))
}

async function importFreshModule() {
  installMocks()
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./onChangeAppState.js?ts=${nonce}`)
}

function buildAppState(
  overrides: Partial<{ mainLoopModel: string | null }> = {},
): AppState {
  return {
    settings: {} as AppState['settings'],
    mainLoopModel: null,
    mainLoopModelForSession: null,
    toolPermissionContext: getEmptyToolPermissionContext(),
    isUltraplanMode: false,
    expandedView: 'none',
    verbose: false,
    ...overrides,
  } as unknown as AppState
}

beforeEach(() => {
  hasOverride = false
  validatedOverrideId = undefined
  saveCurrentProjectConfigCalls = 0
  updateSettingsForSourceCalls = 0
  persistActiveProviderProfileModelCalls = 0
  setMainLoopModelOverrideCalls = []
})

afterEach(() => {
  hasOverride = false
  validatedOverrideId = undefined
})

afterAll(() => {
  mock.module('../utils/config.js', () => realConfig)
  mock.module('../utils/providerProfiles.js', () => realProviderProfiles)
  mock.module('../utils/settings/settings.js', () => realSettings)
  mock.module('../utils/sessionState.js', () => realSessionState)
  mock.module('../utils/auth.js', () => realAuth)
  mock.module('../utils/managedEnv.js', () => realManagedEnv)
  mock.module('../bootstrap/state.js', () => realBootstrapState)
})

describe('suppressNextMainLoopModelPersist', () => {
  test('skips project-scoped persist when override is active (edit-active flow)', async () => {
    const mod = await importFreshModule()
    hasOverride = true
    validatedOverrideId = 'profile-x'

    mod.suppressNextMainLoopModelPersist()
    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'kimi-k2.5' }),
      newState: buildAppState({ mainLoopModel: 'gpt-5.4' }),
    })

    expect(saveCurrentProjectConfigCalls).toBe(0)
    expect(updateSettingsForSourceCalls).toBe(0)
    expect(persistActiveProviderProfileModelCalls).toBe(0)
    expect(setMainLoopModelOverrideCalls).toEqual(['gpt-5.4'])
  })

  test('skips global persist when override is NOT active (delete-active flow)', async () => {
    const mod = await importFreshModule()
    hasOverride = false

    mod.suppressNextMainLoopModelPersist()
    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'kimi-k2.5' }),
      newState: buildAppState({ mainLoopModel: 'gpt-5.4' }),
    })

    expect(updateSettingsForSourceCalls).toBe(0)
    expect(persistActiveProviderProfileModelCalls).toBe(0)
    expect(saveCurrentProjectConfigCalls).toBe(0)
    expect(setMainLoopModelOverrideCalls).toEqual(['gpt-5.4'])
  })

  test('flag is one-shot — second setAppState persists normally', async () => {
    const mod = await importFreshModule()
    hasOverride = true
    validatedOverrideId = 'profile-x'

    mod.suppressNextMainLoopModelPersist()
    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'b' }),
    })
    expect(saveCurrentProjectConfigCalls).toBe(0)

    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'b' }),
      newState: buildAppState({ mainLoopModel: 'c' }),
    })
    expect(saveCurrentProjectConfigCalls).toBe(1)
  })

  test('flag is consumed even when newState has no mainLoopModel diff', async () => {
    // Regression guard for the consume-at-top behavior: the flag MUST be
    // consumed exactly once per setAppState. Verified by arming it, firing a
    // no-op setAppState, then confirming the next legitimate change persists.
    const mod = await importFreshModule()
    hasOverride = true
    validatedOverrideId = 'profile-x'

    mod.suppressNextMainLoopModelPersist()
    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'a' }),
    })

    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'b' }),
    })
    expect(saveCurrentProjectConfigCalls).toBe(1)
  })

  test('dangling override (raw id set, profile missing) falls through to global persist', async () => {
    // Regression guard for Pass 6 M-1: when the raw `activeProviderProfileId`
    // points to a profile that no longer exists, the validated id is
    // undefined. A user `/model` write in that state must NOT be persisted
    // to `activeModelForProject` (which `getUserSpecifiedModelSetting`
    // ignores for dangling overrides) — it must hit the global path.
    const mod = await importFreshModule()
    hasOverride = true
    validatedOverrideId = undefined

    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'b' }),
    })

    expect(saveCurrentProjectConfigCalls).toBe(0)
    expect(updateSettingsForSourceCalls).toBe(1)
    expect(persistActiveProviderProfileModelCalls).toBe(1)
  })
})
