/**
 * Verifies the global LSP master toggle gates lsp_diagnostics emission.
 * When isLspGloballyEnabled() returns false, getLSPDiagnosticAttachments()
 * must return [] without consuming pending diagnostics from the registry.
 *
 * Behavior-level assertion (no mock on the registry itself) so the registry's
 * real bindings remain intact for sibling test files. Bun's mock.module
 * locks namespace shape on first import; mocking registry exports here
 * leaks no-ops into every later test that imports them.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
  getPendingLSPDiagnosticCount,
} from 'src/platform/lsp/LSPDiagnosticRegistry.js'

const mockIsLspGloballyEnabled = mock(() => true)
const realUserSettingsAttachGate = { ...(await import('src/platform/lsp/userSettings.js')) }
mock.module('src/platform/lsp/userSettings.js', () => ({
  ...realUserSettingsAttachGate,
  isLspGloballyEnabled: mockIsLspGloballyEnabled,
}))

function makeContext(toolNames: string[]): ToolUseContext {
  return {
    options: { tools: toolNames.map(name => ({ name })) },
  } as unknown as ToolUseContext
}

beforeEach(() => {
  resetAllLSPDiagnosticState()
  mockIsLspGloballyEnabled.mockReset()
  mockIsLspGloballyEnabled.mockImplementation(() => true)
})

afterEach(() => {
  resetAllLSPDiagnosticState()
  mockIsLspGloballyEnabled.mockReset()
})

afterAll(() => {
  mock.module('src/platform/lsp/userSettings.js', () => realUserSettingsAttachGate)
  mock.module('src/platform/lsp/userSettings.js', () => realUserSettingsAttachGate)
})

const sampleFile = {
  uri: 'file:///tmp/a.ts',
  diagnostics: [
    {
      message: 'oops',
      severity: 'Error' as const,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    },
  ],
}

describe('getLSPDiagnosticAttachments — global gate', () => {
  test('returns [] without consuming registry when LSP is globally disabled', async () => {
    mockIsLspGloballyEnabled.mockImplementation(() => false)
    registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [sampleFile] })
    const before = getPendingLSPDiagnosticCount()

    const { getLSPDiagnosticAttachments } = await import('src/agent/attachments/attachments.js')
    const result = await getLSPDiagnosticAttachments(makeContext([BASH_TOOL_NAME]))

    expect(result).toEqual([])
    // Pending entry must remain — global-off path must not consume it
    expect(getPendingLSPDiagnosticCount()).toBe(before)
  })

  test('returns [] when globally enabled but no diagnostics pending', async () => {
    mockIsLspGloballyEnabled.mockImplementation(() => true)
    const { getLSPDiagnosticAttachments } = await import('src/agent/attachments/attachments.js')
    const result = await getLSPDiagnosticAttachments(makeContext([BASH_TOOL_NAME]))
    expect(result).toEqual([])
  })

  test('emits attachments when globally enabled, Bash present, and diagnostics exist', async () => {
    mockIsLspGloballyEnabled.mockImplementation(() => true)
    registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [sampleFile] })

    const { getLSPDiagnosticAttachments } = await import('src/agent/attachments/attachments.js')
    const result = await getLSPDiagnosticAttachments(makeContext([BASH_TOOL_NAME]))

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'diagnostics', isNew: true })
    // Real registry consumed the pending entry on delivery
    expect(getPendingLSPDiagnosticCount()).toBe(0)
  })

  test('returns [] when Bash tool is not present, regardless of global flag', async () => {
    mockIsLspGloballyEnabled.mockImplementation(() => true)
    registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [sampleFile] })

    const { getLSPDiagnosticAttachments } = await import('src/agent/attachments/attachments.js')
    const result = await getLSPDiagnosticAttachments(makeContext([]))

    expect(result).toEqual([])
  })
})
