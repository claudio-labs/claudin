import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// Spread into plain objects so afterAll restores the original bindings rather
// than the live ESM namespace (which mock.module mutates after the fact).
const realConfig = { ...(await import('src/platform/config/config.js')) }
const realProviderProfiles = { ...(await import('src/providers/presets/providerProfiles.js')) }
const realActiveProvider = {
  ...(await import('src/providers/presets/activeProvider.js')),
}
const realBootstrapState = { ...(await import('src/platform/bootstrap/state.js')) }
const realSettings = { ...(await import('src/platform/settings/settings.js')) }
const realAllowlist = { ...(await import('src/utils/model/modelAllowlist.js')) }

type MockProjectConfig = {
  activeModelForProject?: string
  activeModelForProjectProfileId?: string
}

let projectConfig: MockProjectConfig = {}
let effectiveProfileId: string | undefined
// The effective profile's pinned model — the inherited default a project
// falls back to when it has no valid per-project pin.
let profileModel: string | undefined
let settingsModel: string | undefined

function installMocks(): void {
  mock.module('src/platform/config/config.js', () => ({
    ...realConfig,
    getCurrentProjectConfig: () => projectConfig,
  }))
  mock.module('src/providers/presets/providerProfiles.js', () => ({
    ...realProviderProfiles,
    // The leak guard reads only `.id` off the effective profile.
    getActiveProviderProfile: () =>
      effectiveProfileId ? { id: effectiveProfileId } : undefined,
  }))
  mock.module('src/providers/presets/activeProvider.js', () => ({
    ...realActiveProvider,
    // `getActiveProfileModel` (inherited default) reads `.model` off this.
    tryGetActiveProvider: () => (profileModel ? { model: profileModel } : null),
  }))
  mock.module('src/platform/bootstrap/state.js', () => ({
    ...realBootstrapState,
    getMainLoopModelOverride: () => undefined,
  }))
  mock.module('src/platform/settings/settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => ({ model: settingsModel }),
  }))
  mock.module('./modelAllowlist.js', () => ({
    ...realAllowlist,
    isModelAllowed: () => true,
  }))
}

async function importFreshModel() {
  installMocks()
  return import(`./model.js?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  projectConfig = {}
  effectiveProfileId = undefined
  profileModel = undefined
  settingsModel = undefined
})

afterEach(() => {
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/providers/presets/providerProfiles.js', () => realProviderProfiles)
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProvider)
  mock.module('src/platform/bootstrap/state.js', () => realBootstrapState)
  mock.module('src/platform/settings/settings.js', () => realSettings)
  mock.module('./modelAllowlist.js', () => realAllowlist)
})

afterAll(() => {
  realConfig.resetGlobalConfigForTests?.()
})

test('per-project model is honored WITHOUT any provider override, when its pinned profile matches', async () => {
  // The core ask: /model in a project sticks regardless of whether the project
  // has a per-project *provider* override.
  effectiveProfileId = 'provider_x'
  projectConfig = {
    activeModelForProject: 'opus',
    activeModelForProjectProfileId: 'provider_x',
  }

  const mod = await importFreshModel()
  expect(mod.getUserSpecifiedModelSetting()).toBe('opus')
})

test('per-project model with an undefined pinned profile id is honored (no profiles in env)', async () => {
  effectiveProfileId = undefined
  profileModel = undefined
  projectConfig = {
    activeModelForProject: 'sonnet',
    activeModelForProjectProfileId: undefined,
  }

  const mod = await importFreshModel()
  expect(mod.getUserSpecifiedModelSetting()).toBe('sonnet')
})

test('per-project model is IGNORED when its pinned profile no longer matches the effective provider', async () => {
  // Cross-provider-leak guard: gpt-4o was pinned for provider_openai; the
  // project now resolves to provider_anthropic → fall back to the inherited
  // default instead of serving the wrong-shape model.
  effectiveProfileId = 'provider_anthropic'
  profileModel = 'claude-sonnet-4-6'
  projectConfig = {
    activeModelForProject: 'gpt-4o',
    activeModelForProjectProfileId: 'provider_openai',
  }

  const mod = await importFreshModel()
  expect(mod.getUserSpecifiedModelSetting()).toBe('claude-sonnet-4-6')
})

test('no per-project pin ("Default") inherits the profile model', async () => {
  effectiveProfileId = 'provider_x'
  profileModel = 'claude-opus-4-8'
  projectConfig = { activeModelForProject: undefined }

  const mod = await importFreshModel()
  expect(mod.getUserSpecifiedModelSetting()).toBe('claude-opus-4-8')
})

test('no per-project pin and no profile model inherits settings.model', async () => {
  effectiveProfileId = undefined
  profileModel = undefined
  settingsModel = 'claude-opus-4-8'
  projectConfig = {}

  const mod = await importFreshModel()
  expect(mod.getUserSpecifiedModelSetting()).toBe('claude-opus-4-8')
})

test('no pin, no profile model, no settings.model resolves undefined (subscription default downstream)', async () => {
  const mod = await importFreshModel()
  expect(mod.getUserSpecifiedModelSetting()).toBeUndefined()
})
