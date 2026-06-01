import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// Spread into plain objects so afterAll restores the original bindings rather
// than the live ESM namespace (which mock.module mutates after the fact).
const realConfig = { ...(await import('../config.js')) }
const realProviderProfiles = { ...(await import('../providerProfiles.js')) }
const realActiveProvider = {
  ...(await import('../../services/api/activeProvider.js')),
}
const realBootstrapState = { ...(await import('../../bootstrap/state.js')) }
const realSettings = { ...(await import('../settings/settings.js')) }

type MockProjectConfig = { activeModelForProject?: string }

let projectActiveProfileId: string | undefined
let projectConfig: MockProjectConfig = {}
let activeProviderModel: string | undefined

function installMocks(): void {
  mock.module('../config.js', () => ({
    ...realConfig,
    getCurrentProjectConfig: () => projectConfig,
  }))
  mock.module('../providerProfiles.js', () => ({
    ...realProviderProfiles,
    getProjectActiveProviderProfileId: () => projectActiveProfileId,
  }))
  mock.module('../../services/api/activeProvider.js', () => ({
    ...realActiveProvider,
    tryGetActiveProvider: () =>
      activeProviderModel ? { model: activeProviderModel } : null,
  }))
  mock.module('../../bootstrap/state.js', () => ({
    ...realBootstrapState,
    getMainLoopModelOverride: () => undefined,
  }))
  mock.module('../settings/settings.js', () => ({
    ...realSettings,
    getSettings_DEPRECATED: () => ({}),
  }))
}

async function importFreshModel() {
  installMocks()
  return import(`./model.js?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  projectActiveProfileId = undefined
  projectConfig = {}
  activeProviderModel = undefined
})

afterEach(() => {
  mock.module('../config.js', () => realConfig)
  mock.module('../providerProfiles.js', () => realProviderProfiles)
  mock.module('../../services/api/activeProvider.js', () => realActiveProvider)
  mock.module('../../bootstrap/state.js', () => realBootstrapState)
  mock.module('../settings/settings.js', () => realSettings)
})

afterAll(() => {
  realConfig.resetGlobalConfigForTests?.()
})

test('project override with "Default" choice does not resurface the profile model', async () => {
  // Regression: a project with an active provider override but no explicit
  // per-project model (user picked "Default (recommended)") must NOT fall back
  // to the profile's pinned `model`. Returning undefined lets the
  // subscription-aware default resolve instead of pinning the stale profile
  // model (e.g. an Anthropic profile stuck on claude-opus-4-7).
  projectActiveProfileId = 'provider_x'
  projectConfig = { activeModelForProject: undefined }
  activeProviderModel = 'claude-opus-4-7'

  const mod = await importFreshModel()
  expect(mod.getUserSpecifiedModelSetting()).toBeUndefined()
})

test('project override with an explicit per-project model is honored', async () => {
  projectActiveProfileId = 'provider_x'
  projectConfig = { activeModelForProject: 'opus' }
  activeProviderModel = 'claude-opus-4-7'

  const mod = await importFreshModel()
  expect(mod.getUserSpecifiedModelSetting()).toBe('opus')
})
