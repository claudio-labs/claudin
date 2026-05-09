/**
 * Tests that LSPTool is always included in ALL_TOOLS regardless of env var,
 * and that isEnabled() delegates to isLspConnected().
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const mockIsLspConnected = mock(() => false)
const realLspManager = await import('./services/lsp/manager.js')
mock.module('./services/lsp/manager.js', () => ({
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
  delete process.env.ENABLE_LSP_TOOL
})

afterAll(() => {
  mock.module('./services/lsp/manager.js', () => realLspManager)
})

describe('LSP tool gate', () => {
  test('LSPTool.isEnabled() returns false when isLspConnected() returns false', async () => {
    mockIsLspConnected.mockImplementation(() => false)
    const { LSPTool } = await import('./tools/LSPTool/LSPTool.js')
    expect(LSPTool.isEnabled()).toBe(false)
  })

  test('LSPTool.isEnabled() returns true when isLspConnected() returns true', async () => {
    mockIsLspConnected.mockImplementation(() => true)
    const { LSPTool } = await import('./tools/LSPTool/LSPTool.js')
    expect(LSPTool.isEnabled()).toBe(true)
  })

  test('ENABLE_LSP_TOOL env var is no longer needed — LSPTool always present', async () => {
    delete process.env.ENABLE_LSP_TOOL
    mockIsLspConnected.mockImplementation(() => true)
    const { LSPTool } = await import('./tools/LSPTool/LSPTool.js')
    // LSPTool should still be enabled when LSP is connected, without env var
    expect(LSPTool.isEnabled()).toBe(true)
  })

  test('ENABLE_LSP_TOOL=0 does not disable LSPTool — gate is isLspConnected only', async () => {
    process.env.ENABLE_LSP_TOOL = '0'
    mockIsLspConnected.mockImplementation(() => true)
    const { LSPTool } = await import('./tools/LSPTool/LSPTool.js')
    expect(LSPTool.isEnabled()).toBe(true)
  })
})
