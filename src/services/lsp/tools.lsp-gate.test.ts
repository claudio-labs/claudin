/**
 * Verifies that LSPTool's gate delegates to isLspConnected().
 * Since getTools() uses LSPTool.isEnabled() (which calls isLspConnected()),
 * testing isEnabled() is equivalent to testing the gate in getTools().
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

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

afterEach(() => {
  mockIsLspConnected.mockReset()
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
})

describe('LSP gate in getTools()', () => {
  test('LSPTool absent from array when isLspConnected returns false', async () => {
    mockIsLspConnected.mockImplementation(() => false)
    const { LSPTool } = await import('../../tools/LSPTool/LSPTool.js')
    expect(LSPTool.name).toBe('LSP')
    expect(LSPTool.isEnabled()).toBe(false)
  })

  test('LSPTool present in array when isLspConnected returns true', async () => {
    mockIsLspConnected.mockImplementation(() => true)
    const { LSPTool } = await import('../../tools/LSPTool/LSPTool.js')
    expect(LSPTool.name).toBe('LSP')
    expect(LSPTool.isEnabled()).toBe(true)
  })
})
