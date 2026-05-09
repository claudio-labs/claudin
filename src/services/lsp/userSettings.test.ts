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

describe('getUserLspSettings', () => {
  test('returns {} when lsp is undefined in settings', async () => {
    mockGetInitialSettings.mockImplementation(() => ({}))
    const { getUserLspSettings } = await freshModule()
    expect(getUserLspSettings()).toEqual({})
  })

  test('returns lsp map when configured', async () => {
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: {
        'typescript-language-server': { disabled: true },
        'my-server': { command: ['my-lsp', '--stdio'], extensions: ['.xyz'] },
      },
    }))
    const { getUserLspSettings } = await freshModule()
    const result = getUserLspSettings()
    expect(result['typescript-language-server']).toEqual({ disabled: true })
    expect(result['my-server']).toEqual({ command: ['my-lsp', '--stdio'], extensions: ['.xyz'] })
  })

  test('does not propagate exception when getInitialSettings throws', async () => {
    mockGetInitialSettings.mockImplementation(() => { throw new Error('settings error') })
    const { getUserLspSettings } = await freshModule()
    expect(() => getUserLspSettings()).not.toThrow()
    expect(getUserLspSettings()).toEqual({})
  })

  test('returns {} when lsp is empty object', async () => {
    mockGetInitialSettings.mockImplementation(() => ({ lsp: {} }))
    const { getUserLspSettings } = await freshModule()
    expect(getUserLspSettings()).toEqual({})
  })
})

describe('UserLspServerSetting schema', () => {
  test('disabled:true is valid', async () => {
    mockGetInitialSettings.mockImplementation(() => ({ lsp: { srv: { disabled: true } } }))
    const { getUserLspSettings } = await freshModule()
    expect(getUserLspSettings()['srv']?.disabled).toBe(true)
  })

  test('command array is valid', async () => {
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: { srv: { command: ['cmd', '--stdio'], extensions: ['.ts'] } },
    }))
    const { getUserLspSettings } = await freshModule()
    const result = getUserLspSettings()
    expect(result['srv']?.command).toEqual(['cmd', '--stdio'])
    expect(result['srv']?.extensions).toEqual(['.ts'])
  })
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

  test('coexists with per-server settings: enabled:false but server entries still parse', async () => {
    mockGetInitialSettings.mockImplementation(() => ({
      lsp: {
        enabled: false,
        'typescript-language-server': { disabled: true },
      },
    }))
    const { isLspGloballyEnabled, getUserLspSettings } = await freshModule()
    expect(isLspGloballyEnabled()).toBe(false)
    const servers = getUserLspSettings()
    expect(servers['typescript-language-server']?.disabled).toBe(true)
    // The reserved 'enabled' key must not be exposed as a server entry.
    expect(servers['enabled']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('../../utils/settings/settings.js', () => realSettingsUserSettings)
})
