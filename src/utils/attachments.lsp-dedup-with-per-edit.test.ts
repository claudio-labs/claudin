/**
 * Integration test: per-edit injection + turn-level pull share the same LRU.
 *
 * After buildPostEditDiagnosticsMessages delivers a diagnostic per-edit and
 * calls markDiagnosticsAsDelivered, the next turn-level pull via
 * getLSPDiagnosticAttachments must NOT re-emit the same diagnostic — content
 * hash matches what was marked, so the dedup LRU swallows it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../Tool.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import type { DiagnosticFile } from '../services/diagnosticTracking.js'
import {
  _resetFileWaitersForTesting,
  markDiagnosticsAsDelivered,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from '../services/lsp/LSPDiagnosticRegistry.js'

// Force-enable the LSP master toggle so this suite is deterministic regardless
// of the local user's ~/.claudio/settings.json (lsp.enabled may be false).
const realUserSettings = await import('../services/lsp/userSettings.js')
mock.module('../services/lsp/userSettings.js', () => ({
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

describe('LSP dedup: per-edit + turn-level share the LRU', () => {
  test('after per-edit delivers D for F, the next turn-level pull skips D', async () => {
    // Simulate per-edit consumption: server published, waiter resolved with [F],
    // helper called markDiagnosticsAsDelivered([F]).
    markDiagnosticsAsDelivered([fileF])

    // Now simulate the LSP server publishing the SAME diagnostic again
    // (e.g. the publishDiagnostics also reaches the registry asynchronously
    // after per-edit already settled). The pending entry is still queued.
    registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileF] })

    const { getLSPDiagnosticAttachments } = await import('./attachments.js')
    const result = await getLSPDiagnosticAttachments(makeCtx())
    expect(result).toEqual([])
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

    const { getLSPDiagnosticAttachments } = await import('./attachments.js')
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
