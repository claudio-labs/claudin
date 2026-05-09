/**
 * Verifies the global LSP master toggle composes with isLspConnected() when
 * deciding whether to expose LSPTool in getTools(). The exact gate from
 * tools.ts is: `isLspGloballyEnabled() && isLspConnected()` — this test
 * still exercises `LSPTool.isEnabled()` directly because that function is
 * a pure wrapper of `isLspConnected()` (see tools/LSPTool/LSPTool.ts).
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

// Capture real modules before mocking so afterAll can fully restore them.
const realSettingsGate = { ...(await import('../../utils/settings/settings.js')) }

const mockIsLspConnected = mock(() => false)
mock.module('../../services/lsp/manager.js', () => ({
  isLspConnected: mockIsLspConnected,
  reinitializeLspServerManager: mock(() => {}),
  getLspServerManager: mock(() => undefined),
  initializeLspServerManager: mock(() => {}),
  shutdownLspServerManager: mock(async () => {}),
  getInitializationStatus: mock(() => ({ status: 'not-started' })),
  waitForInitialization: mock(async () => {}),
  _resetLspManagerForTesting: mock(() => {}),
}))

const mockGetInitialSettings = mock(() => ({} as { lsp?: { enabled?: boolean } }))
mock.module('../../utils/settings/settings.js', () => ({
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
}))

afterEach(() => {
  mockIsLspConnected.mockReset()
  mockGetInitialSettings.mockReset()
})

async function freshUserSettings() {
  return import(`./userSettings.ts?gate=${Date.now()}-${Math.random()}`)
}

describe('LSP global toggle gate composition', () => {
  test('gate is true only when both flags are on', async () => {
    mockIsLspConnected.mockImplementation(() => true)
    mockGetInitialSettings.mockImplementation(() => ({ lsp: { enabled: true } }))
    const { LSPTool } = await import('../../tools/LSPTool/LSPTool.js')
    const { isLspGloballyEnabled } = await freshUserSettings()
    expect(isLspGloballyEnabled() && LSPTool.isEnabled()).toBe(true)
  })

  test('gate is false when global toggle is off, even if connected', async () => {
    mockIsLspConnected.mockImplementation(() => true)
    mockGetInitialSettings.mockImplementation(() => ({ lsp: { enabled: false } }))
    const { LSPTool } = await import('../../tools/LSPTool/LSPTool.js')
    const { isLspGloballyEnabled } = await freshUserSettings()
    expect(isLspGloballyEnabled() && LSPTool.isEnabled()).toBe(false)
  })

  test('gate is false when not connected, even if globally enabled', async () => {
    mockIsLspConnected.mockImplementation(() => false)
    mockGetInitialSettings.mockImplementation(() => ({ lsp: { enabled: true } }))
    const { LSPTool } = await import('../../tools/LSPTool/LSPTool.js')
    const { isLspGloballyEnabled } = await freshUserSettings()
    expect(isLspGloballyEnabled() && LSPTool.isEnabled()).toBe(false)
  })

  test('default (no lsp.enabled key) treats LSP as enabled', async () => {
    mockIsLspConnected.mockImplementation(() => true)
    mockGetInitialSettings.mockImplementation(() => ({}))
    const { LSPTool } = await import('../../tools/LSPTool/LSPTool.js')
    const { isLspGloballyEnabled } = await freshUserSettings()
    expect(isLspGloballyEnabled()).toBe(true)
    expect(isLspGloballyEnabled() && LSPTool.isEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Restore module mocks so leaks don't bleed into subsequent test files.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('../../services/lsp/manager.js', () => ({
    reinitializeLspServerManager: () => {},
    isLspConnected: () => false,
    getLspServerManager: () => undefined,
    initializeLspServerManager: () => {},
    shutdownLspServerManager: async () => {},
    getInitializationStatus: () => ({ status: 'not-started' }),
    waitForInitialization: async () => {},
    _resetLspManagerForTesting: () => {},
  }))
  mock.module('../../utils/settings/settings.js', () => realSettingsGate)
})
