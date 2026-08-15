import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import type { ProjectConfig } from 'src/services/config/config.js'

// These tests verify two contracts of the `mainLoopModel` diff handler:
//  1. `/model` is ALWAYS project-scoped — a write persists to
//     `activeModelForProject` (+ the effective provider profile id) and never
//     touches global `settings.model` / the profile's global model, regardless
//     of any per-project provider override.
//  2. `suppressNextMainLoopModelPersist` skips the project-scoped persist for
//     provider-switch consequence flows.
// They exercise `onChangeAppState` directly with mocked persistence boundaries.

const realConfig = { ...(await import('src/services/config/config.js')) }
const realProviderProfiles = {
  ...(await import('src/services/api/providerProfiles.js')),
}
const realSettings = { ...(await import('src/services/settings/settings.js')) }
const realSessionState = { ...(await import('src/services/session/sessionState.js')) }
const realAuth = { ...(await import('src/services/auth/auth.js')) }
const realManagedEnv = { ...(await import('src/services/config/managedEnv.js')) }
const realBootstrapState = { ...(await import('src/bootstrap/state.js')) }

let activeProfileId: string | undefined
let savedProjectConfigs: Partial<ProjectConfig>[]
// A settings write from the model branch would be a regression (global leak);
// keep a counter so we can assert it stays zero.
let updateSettingsForSourceCalls: number
let setMainLoopModelOverrideCalls: Array<unknown>

function installMocks(): void {
  mock.module('src/services/config/config.js', () => ({
    ...realConfig,
    getGlobalConfig: () => ({}),
    saveGlobalConfig: () => {},
    saveCurrentProjectConfig: (
      updater: (current: ProjectConfig) => ProjectConfig,
    ) => {
      savedProjectConfigs.push(updater({} as ProjectConfig))
    },
  }))
  mock.module('src/services/api/providerProfiles.js', () => ({
    ...realProviderProfiles,
    getActiveProviderProfile: () =>
      activeProfileId ? { id: activeProfileId } : undefined,
  }))
  mock.module('src/services/settings/settings.js', () => ({
    ...realSettings,
    updateSettingsForSource: () => {
      updateSettingsForSourceCalls += 1
    },
  }))
  mock.module('src/services/session/sessionState.js', () => ({
    ...realSessionState,
    notifySessionMetadataChanged: () => {},
    notifyPermissionModeChanged: () => {},
  }))
  mock.module('src/services/auth/auth.js', () => ({
    ...realAuth,
    clearApiKeyHelperCache: () => {},
    clearAwsCredentialsCache: () => {},
    clearGcpCredentialsCache: () => {},
  }))
  mock.module('src/services/config/managedEnv.js', () => ({
    ...realManagedEnv,
    applyConfigEnvironmentVariables: () => {},
  }))
  mock.module('src/bootstrap/state.js', () => ({
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
  activeProfileId = undefined
  savedProjectConfigs = []
  updateSettingsForSourceCalls = 0
  setMainLoopModelOverrideCalls = []
})

afterEach(() => {
  activeProfileId = undefined
})

afterAll(() => {
  mock.module('src/services/config/config.js', () => realConfig)
  mock.module('src/services/api/providerProfiles.js', () => realProviderProfiles)
  mock.module('src/services/settings/settings.js', () => realSettings)
  mock.module('src/services/session/sessionState.js', () => realSessionState)
  mock.module('src/services/auth/auth.js', () => realAuth)
  mock.module('src/services/config/managedEnv.js', () => realManagedEnv)
  mock.module('src/bootstrap/state.js', () => realBootstrapState)
})

describe('mainLoopModel persistence is always project-scoped', () => {
  test('a /model pick persists to the project + pins the effective profile id', async () => {
    const mod = await importFreshModule()
    activeProfileId = 'profile-x'

    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'gpt-5.4' }),
    })

    expect(savedProjectConfigs).toEqual([
      {
        activeModelForProject: 'gpt-5.4',
        activeModelForProjectProfileId: 'profile-x',
      },
    ])
    // Never leak to global settings / profile model.
    expect(updateSettingsForSourceCalls).toBe(0)
    expect(setMainLoopModelOverrideCalls).toEqual(['gpt-5.4'])
  })

  test('a /model pick with no provider profiles pins an undefined id (still project-scoped)', async () => {
    const mod = await importFreshModule()
    activeProfileId = undefined

    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'opus' }),
    })

    expect(savedProjectConfigs).toEqual([
      {
        activeModelForProject: 'opus',
        activeModelForProjectProfileId: undefined,
      },
    ])
    expect(updateSettingsForSourceCalls).toBe(0)
  })

  test('"default" (null) clears the project pin without touching global state', async () => {
    const mod = await importFreshModule()

    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'opus' }),
      newState: buildAppState({ mainLoopModel: null }),
    })

    expect(savedProjectConfigs).toEqual([
      {
        activeModelForProject: undefined,
        activeModelForProjectProfileId: undefined,
      },
    ])
    expect(updateSettingsForSourceCalls).toBe(0)
    expect(setMainLoopModelOverrideCalls).toEqual([null])
  })
})

describe('suppressNextMainLoopModelPersist', () => {
  test('skips the project-scoped persist for a provider-switch consequence', async () => {
    const mod = await importFreshModule()
    activeProfileId = 'profile-x'

    mod.suppressNextMainLoopModelPersist()
    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'kimi-k2.5' }),
      newState: buildAppState({ mainLoopModel: 'gpt-5.4' }),
    })

    expect(savedProjectConfigs).toEqual([])
    expect(updateSettingsForSourceCalls).toBe(0)
    expect(setMainLoopModelOverrideCalls).toEqual(['gpt-5.4'])
  })

  test('flag is one-shot — second setAppState persists normally', async () => {
    const mod = await importFreshModule()
    activeProfileId = 'profile-x'

    mod.suppressNextMainLoopModelPersist()
    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'b' }),
    })
    expect(savedProjectConfigs).toHaveLength(0)

    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'b' }),
      newState: buildAppState({ mainLoopModel: 'c' }),
    })
    expect(savedProjectConfigs).toHaveLength(1)
  })

  test('flag is consumed even when newState has no mainLoopModel diff', async () => {
    // Regression guard for the consume-at-top behavior: the flag MUST be
    // consumed exactly once per setAppState. Verified by arming it, firing a
    // no-op setAppState, then confirming the next legitimate change persists.
    const mod = await importFreshModule()
    activeProfileId = 'profile-x'

    mod.suppressNextMainLoopModelPersist()
    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'a' }),
    })

    mod.onChangeAppState({
      oldState: buildAppState({ mainLoopModel: 'a' }),
      newState: buildAppState({ mainLoopModel: 'b' }),
    })
    expect(savedProjectConfigs).toHaveLength(1)
  })
})
