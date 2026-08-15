/**
 * Performance benchmarks for awaitDiagnosticsForFile.
 *
 * Asserts:
 *  - Fast-path (URI already in pendingDiagnostics) avg < 5ms over 100 runs.
 *  - Timeout path falls inside [timeoutMs, timeoutMs + jitter].
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DiagnosticFile } from 'src/platform/diagnosticTracking.js'
import {
  _resetFileWaitersForTesting,
  awaitDiagnosticsForFile,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from 'src/platform/lsp/LSPDiagnosticRegistry.js'

const file: DiagnosticFile = {
  uri: 'file:///tmp/perf.ts',
  diagnostics: [
    {
      message: 'perf',
      severity: 'Error',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
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

describe('awaitDiagnosticsForFile — performance', () => {
  it('fast-path average is sub-5ms over 100 runs', async () => {
    const iterations = 100
    let total = 0
    for (let i = 0; i < iterations; i++) {
      // Pre-populate the registry — simulates the case where the LSP server
      // published before our await registered.
      resetAllLSPDiagnosticState()
      registerPendingLSPDiagnostic({ serverName: 'tsserver', files: [file] })
      const start = performance.now()
      const r = await awaitDiagnosticsForFile(file.uri, 1500)
      total += performance.now() - start
      expect(r).not.toBeNull()
    }
    const avg = total / iterations
    console.log(`[perf] awaitDiagnosticsForFile fast-path avg: ${avg.toFixed(3)}ms`)
    expect(avg).toBeLessThan(5)
  })

  it('timeout path resolves null within the requested window plus jitter', async () => {
    const target = 100
    const start = performance.now()
    const r = await awaitDiagnosticsForFile(file.uri, target)
    const elapsed = performance.now() - start
    console.log(`[perf] awaitDiagnosticsForFile timeout (target ${target}ms): ${elapsed.toFixed(3)}ms`)
    expect(r).toBeNull()
    // Timer is allowed to fire slightly early on some platforms; allow ±10%
    expect(elapsed).toBeGreaterThanOrEqual(target * 0.9)
    // Generous CI jitter ceiling.
    expect(elapsed).toBeLessThan(target + 200)
  })
})
