/**
 * Integration test: per-edit injection + turn-level pull share the same LRU.
 *
 * After buildPostEditDiagnosticsMessages delivers a diagnostic per-edit and
 * calls markDiagnosticsAsDelivered, the next turn-level pull via
 * getLSPDiagnosticAttachments must NOT re-emit the same diagnostic — content
 * hash matches what was marked, so the dedup LRU swallows it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from 'src/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import type { DiagnosticFile } from 'src/services/diagnosticTracking.js'
import {
  _resetFileWaitersForTesting,
  markDiagnosticsAsDelivered,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from 'src/services/lsp/LSPDiagnosticRegistry.js'

// Force-enable the LSP master toggle so this suite is deterministic regardless
// of the local user's ~/.claudin/settings.json (lsp.enabled may be false).
const realUserSettings = { ...(await import('src/services/lsp/userSettings.js')) }
mock.module('src/services/lsp/userSettings.js', () => ({
  ...realUserSettings,
  isLspGloballyEnabled: () => true,
}))

function makeCtx(): ToolUseContext {
  return {
    options: { tools: [{ name: BASH_TOOL_NAME }] },
  } as unknown as ToolUseContext
}

const fileF: DiagnosticFile = {
  uri: 'file:///tmp/F.ts',
  diagnostics: [
    {
      message: 'Type X is not assignable to Y',
      severity: 'Error',
      range: {
        start: { line: 3, character: 0 },
        end: { line: 3, character: 5 },
      },
      source: 'ts',
      code: '2322',
    },
  ],
}

beforeEach(() => {
  resetAllLSPDiagnosticState()
  _resetFileWaitersForTesting()
})

afterEach(() => {
  resetAllLSPDiagnosticState()
  _resetFileWaitersForTesting()
})

afterAll(() => {
  mock.module('src/services/lsp/userSettings.js', () => realUserSettings)
})

describe('LSP dedup: per-edit + turn-level share the LRU', () => {
  test('after per-edit delivers D for F, the next turn-level pull skips D', async () => {
    // Simulate per-edit consumption: server published, waiter resolved with [F],
    // helper called markDiagnosticsAsDelivered([F]).
    markDiagnosticsAsDelivered([fileF])

    // Now simulate the LSP server publishing the SAME diagnostic again
    // (e.g. the publishDiagnostics also reaches the registry asynchronously
    // after per-edit already settled). The pending entry is still queued.
    registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileF] })

    const { getLSPDiagnosticAttachments } = await import('src/services/attachments/attachments.js')
    const result = await getLSPDiagnosticAttachments(makeCtx())
    expect(result).toEqual([])
  })

  test('tail-wait flow: awaitLateDiagnosticsForTurn output, when marked delivered by query.ts, is skipped by the next pull', async () => {
    // Simulate the late-injection path: armed file gets a publish, query.ts
    // calls markDiagnosticsAsDelivered on the surviving lateFiles, then on
    // the NEXT user turn getLSPDiagnosticAttachments must not re-emit.
    const {
      armFileForLateDiagnostics,
      awaitLateDiagnosticsForTurn,
      clearArmedFiles,
    } = await import('src/services/lsp/diagnosticsForToolResult.js')
    // Mock the lsp manager so arm() doesn't reject due to no server.
    const realManager = { ...(await import('src/services/lsp/manager.js')) }
    mock.module('src/services/lsp/manager.js', () => ({
      ...realManager,
      getLspServerManager: () => ({ getServerForFile: () => ({}) }),
    }))

    try {
      clearArmedFiles()
      armFileForLateDiagnostics('/tmp/F.ts', undefined)
      registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileF] })

      const lateFiles = await awaitLateDiagnosticsForTurn()
      expect(lateFiles).toHaveLength(1)
      markDiagnosticsAsDelivered(lateFiles)
      clearArmedFiles()

      // Republish — next turn pull must dedup.
      registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileF] })
      const { getLSPDiagnosticAttachments } = await import('src/services/attachments/attachments.js')
      const result = await getLSPDiagnosticAttachments(makeCtx())
      expect(result).toEqual([])
    } finally {
      // Restore manager mock so the rest of the suite is unaffected.
      mock.module('src/services/lsp/manager.js', () => realManager)
    }
  })

  test('a NEW diagnostic for the same file IS still delivered next turn', async () => {
    // Per-edit consumed F's first diagnostic.
    markDiagnosticsAsDelivered([fileF])

    // A second, different diagnostic appears for the same file later.
    const fileFNext: DiagnosticFile = {
      uri: fileF.uri,
      diagnostics: [
        {
          message: 'Different unrelated error',
          severity: 'Warning',
          range: {
            start: { line: 10, character: 0 },
            end: { line: 10, character: 1 },
          },
          source: 'ts',
          code: '4444',
        },
      ],
    }
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileFNext],
    })

    const { getLSPDiagnosticAttachments } = await import('src/services/attachments/attachments.js')
    const result = await getLSPDiagnosticAttachments(makeCtx())
    expect(result).toHaveLength(1)
    if (result[0]!.type === 'diagnostics') {
      expect(result[0]!.files).toHaveLength(1)
      expect(result[0]!.files[0]!.diagnostics[0]!.message).toBe(
        'Different unrelated error',
      )
    }
  })
})

afterAll(() => {
  mock.module('src/services/lsp/userSettings.js', () => realUserSettings)
  mock.module('src/services/lsp/userSettings.js', () => realUserSettings)
})
