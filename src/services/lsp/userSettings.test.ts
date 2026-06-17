import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const realSettingsUserSettings = { ...(await import('../../utils/settings/settings.js')) }

const mockGetInitialSettings = mock(() => ({}))

const SETTINGS_MOCK_FACTORY = () => ({
  getInitialSettings: mockGetInitialSettings,
  updateSettingsForSource: async () => {},
  setSetting: async () => {},
  loadSettings: async () => ({}),
  getSettingsForSource: () => ({}),
  getSettingsWithSources: () => ({}),
  getSettingsWithErrors: () => ({ settings: {}, errors: [] }),
  getSettings_DEPRECATED: () => ({}),
  loadManagedFileSettings: () => ({ settings: {}, errors: [] }),
  getManagedFileSettingsPresence: () => ({}),
  parseSettingsFile: () => ({ settings: {}, errors: [] }),
  getSettingsRootPathForSource: () => '',
  getSettingsFilePathForSource: () => '',
  getRelativeSettingsFilePathForSource: () => '',
  getPolicySettingsOrigin: () => ({}),
  settingsMergeCustomizer: () => undefined,
  getManagedSettingsKeysForLogging: () => [],
  hasSkipDangerousModePermissionPrompt: () => false,
  hasAllowBypassPermissionsMode: () => false,
  hasAutoModeOptIn: () => false,
  getUseAutoModeDuringPlan: () => false,
  getAutoModeConfig: () => ({}),
  rawSettingsContainsKey: () => false,
})

// Install mock at module level so Bun registers it before any test runs.
mock.module('../../utils/settings/settings.js', SETTINGS_MOCK_FACTORY)

async function freshModule() {
  // Re-install the mock with our spy before each fresh import, ensuring that
  // any prior file's afterAll that replaced settings.js doesn't affect us.
  mock.module('../../utils/settings/settings.js', SETTINGS_MOCK_FACTORY)
  return import(`./userSettings.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mockGetInitialSettings.mockReset()
})

beforeEach(() => {
  // Ensure our spy is active even if a previous test file replaced settings.js.
  mock.module('../../utils/settings/settings.js', SETTINGS_MOCK_FACTORY)
})

describe('isLspGloballyEnabled', () => {
  test('returns true when lsp is undefined (default)', async () => {
    mockGetInitialSettings.mockImplementation(() => ({}))
    const { isLspGloballyEnabled } = await freshModule()
    expect(isLspGloballyEnabled()).toBe(true)
  })

  test('returns true when lsp.enabled is undefined', async () => {
    mockGetInitialSettings.mockImplementation(() => ({ lsp: {} }))
    const { isLspGloballyEnabled } = await freshModule()
    expect(isLspGloballyEnabled()).toBe(true)
  })

  test('returns true when lsp.enabled is true', async () => {
    mockGetInitialSettings.mockImplementation(() => ({ lsp: { enabled: true } }))
    const { isLspGloballyEnabled } = await freshModule()
    expect(isLspGloballyEnabled()).toBe(true)
  })

  test('returns false when lsp.enabled is false', async () => {
    mockGetInitialSettings.mockImplementation(() => ({ lsp: { enabled: false } }))
    const { isLspGloballyEnabled } = await freshModule()
    expect(isLspGloballyEnabled()).toBe(false)
  })

  test('returns true when getInitialSettings throws', async () => {
    mockGetInitialSettings.mockImplementation(() => { throw new Error('boom') })
    const { isLspGloballyEnabled } = await freshModule()
    expect(isLspGloballyEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('../../utils/settings/settings.js', () => realSettingsUserSettings)
})
