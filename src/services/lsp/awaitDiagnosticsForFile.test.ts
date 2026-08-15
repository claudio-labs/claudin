/**
 * Tests for awaitDiagnosticsForFile + markDiagnosticsAsDelivered.
 *
 * Covers:
 *  - fast-path: pendingDiagnostics already has the URI → resolves immediately
 *  - slow-path: registerPendingLSPDiagnostic fires later → resolves
 *  - timeout: nothing arrives → resolves null
 *  - URI mismatch: waiter for X is not notified by registration for Y
 *  - cleanup on resolve and on timeout: fileWaiters map empties out
 *  - markDiagnosticsAsDelivered populates the LRU so the next checkForLSPDiagnostics dedups
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { DiagnosticFile } from 'src/services/diagnosticTracking.js'
import {
  _getFileWaiterCountForTesting,
  _resetFileWaitersForTesting,
  awaitDiagnosticsForFile,
  checkForLSPDiagnostics,
  markDiagnosticsAsDelivered,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from 'src/services/lsp/LSPDiagnosticRegistry.js'

const fileX: DiagnosticFile = {
  uri: 'file:///tmp/x.ts',
  diagnostics: [
    {
      message: 'Type X is not assignable',
      severity: 'Error',
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 5 },
      },
      source: 'ts',
      code: '2322',
    },
  ],
}

const fileY: DiagnosticFile = {
  uri: 'file:///tmp/y.ts',
  diagnostics: [
    {
      message: 'Other file error',
      severity: 'Error',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      source: 'ts',
      code: '1',
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

describe('awaitDiagnosticsForFile', () => {
  test('fast-path: resolves immediately when URI is already in pendingDiagnostics', async () => {
    registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileX] })

    const start = performance.now()
    const result = await awaitDiagnosticsForFile(fileX.uri, 1500)
    const elapsed = performance.now() - start

    expect(result).not.toBeNull()
    expect(result).toHaveLength(1)
    expect(result![0]!.uri).toBe(fileX.uri)
    // Fast-path is a synchronous scan, awaited via Promise.resolve. Way under timeout.
    expect(elapsed).toBeLessThan(50)
  })

  test('slow-path: resolves when registerPendingLSPDiagnostic fires after the await begins', async () => {
    setTimeout(() => {
      registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileX] })
    }, 30)

    const start = performance.now()
    const result = await awaitDiagnosticsForFile(fileX.uri, 1500)
    const elapsed = performance.now() - start

    expect(result).not.toBeNull()
    expect(result).toHaveLength(1)
    expect(result![0]!.uri).toBe(fileX.uri)
    // Should resolve shortly after the 30ms register, well under the timeout.
    expect(elapsed).toBeLessThan(200)
  })

  test('timeout: resolves null when no diagnostics arrive within the window', async () => {
    const start = performance.now()
    const result = await awaitDiagnosticsForFile(fileX.uri, 80)
    const elapsed = performance.now() - start

    expect(result).toBeNull()
    // Allow generous margin for CI scheduling jitter.
    expect(elapsed).toBeGreaterThanOrEqual(70)
    expect(elapsed).toBeLessThan(300)
  })

  test('URI mismatch: a waiter for X is NOT notified when Y registers', async () => {
    let waiterResolved = false
    const waiter = awaitDiagnosticsForFile(fileX.uri, 80).then(r => {
      waiterResolved = r !== null
    })

    // Register for a DIFFERENT URI — must not fire X's waiter.
    registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileY] })

    // Give microtask queue a chance to flush, then check waiter is still pending.
    await new Promise(r => setTimeout(r, 10))
    expect(waiterResolved).toBe(false)
    expect(_getFileWaiterCountForTesting(fileX.uri)).toBe(1)

    await waiter
    expect(waiterResolved).toBe(false)
  })

  test('cleanup on resolve: fileWaiters has no entry for the URI after success', async () => {
    setTimeout(() => {
      registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileX] })
    }, 20)

    const result = await awaitDiagnosticsForFile(fileX.uri, 1500)
    expect(result).not.toBeNull()
    expect(_getFileWaiterCountForTesting(fileX.uri)).toBe(0)
    expect(_getFileWaiterCountForTesting()).toBe(0)
  })

  test('cleanup on timeout: fileWaiters has no entry for the URI after timeout', async () => {
    const result = await awaitDiagnosticsForFile(fileX.uri, 50)
    expect(result).toBeNull()
    expect(_getFileWaiterCountForTesting(fileX.uri)).toBe(0)
    expect(_getFileWaiterCountForTesting()).toBe(0)
  })

  test('multiple waiters on same URI both fire on register', async () => {
    const w1 = awaitDiagnosticsForFile(fileX.uri, 1500)
    const w2 = awaitDiagnosticsForFile(fileX.uri, 1500)
    setTimeout(() => {
      registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileX] })
    }, 10)
    const [r1, r2] = await Promise.all([w1, w2])
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(_getFileWaiterCountForTesting()).toBe(0)
  })
})

describe('markDiagnosticsAsDelivered', () => {
  test('populates the dedup LRU so the next checkForLSPDiagnostics skips matching diagnostics', () => {
    // Per-edit path: receive files via waiter, then mark.
    markDiagnosticsAsDelivered([fileX])

    // Now simulate what passiveFeedback would do — push the same content to the registry.
    registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [fileX] })

    // Turn-level pull must now skip — content-hash matches what we marked.
    const out = checkForLSPDiagnostics()
    expect(out).toEqual([])
  })

  test('different content for the same URI is NOT dedup-skipped', () => {
    markDiagnosticsAsDelivered([fileX])

    const fileXMutated: DiagnosticFile = {
      uri: fileX.uri,
      diagnostics: [
        {
          message: 'A NEW different error',
          severity: 'Error',
          range: {
            start: { line: 99, character: 0 },
            end: { line: 99, character: 1 },
          },
          source: 'ts',
          code: '9999',
        },
      ],
    }
    registerPendingLSPDiagnostic({
      serverName: 'tsserver',
      files: [fileXMutated],
    })
    const out = checkForLSPDiagnostics()
    expect(out).toHaveLength(1)
    expect(out[0]!.files).toHaveLength(1)
    expect(out[0]!.files[0]!.diagnostics[0]!.message).toBe(
      'A NEW different error',
    )
  })
})
