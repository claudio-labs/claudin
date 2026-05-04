/**
 * Verifies that LSPTool's module is NOT evaluated when the gate is closed.
 *
 * Counts how many times the LSPTool module factory runs as we call
 * getAllBaseTools() with isLspConnected=false vs true. With lazy require()
 * gating in tools.ts (ROADMAP 5.9), the module should only evaluate when
 * the gate opens.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

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

mock.module('../../services/lsp/userSettings.js', () => ({
  isLspGloballyEnabled: () => true,
  getUserLspSettings: () => ({}),
}))

let lspToolFactoryCallCount = 0
mock.module('../../tools/LSPTool/LSPTool.js', () => {
  lspToolFactoryCallCount++
  // Stub a minimal Tool surface so getAllBaseTools() can include it.
  return {
    LSPTool: {
      name: 'LSP',
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      isMcp: false,
      mcpInfo: undefined,
    },
  }
})

beforeEach(() => {
  lspToolFactoryCallCount = 0
})

afterEach(() => {
  mockIsLspConnected.mockReset()
})

afterAll(async () => {
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
  // Restore the real LSPTool module so subsequent tests in the same run
  // (e.g. tools.lsp-global-gate.test.ts) don't see the stub from this file.
  // mock.module is global to the test run; an explicit restore is required.
  const real = await import('../../tools/LSPTool/LSPTool.js')
  mock.module('../../tools/LSPTool/LSPTool.js', () => real)
})

describe('LSPTool lazy load (ROADMAP 5.9)', () => {
  test('LSPTool module is NOT evaluated when isLspConnected=false', async () => {
    mockIsLspConnected.mockImplementation(() => false)
    const { getAllBaseTools } = await import('../../tools.js')
    const tools = getAllBaseTools()
    expect(tools.find(t => t.name === 'LSP')).toBeUndefined()
    // The factory tracked by lspToolFactoryCallCount is only invoked when
    // tools.ts calls require('./tools/LSPTool/LSPTool.js'). Eager-import
    // regressions show up here as count > 0.
    expect(lspToolFactoryCallCount).toBe(0)
  })
})
