/**
 * A3 regression — sticky defer latch for LSP tools.
 *
 * shouldDeferLspTool (streaming.ts) used to flip defer_loading true→false
 * the moment LSP initialization completed. The API strips deferred schemas
 * from the prompt, so the flip added the tool's schema to the effective
 * tools array mid-session — a spontaneous full prompt-cache invalidation.
 * (The break detector already excluded defer_loading tools from its hash,
 * which silenced the report but not the break itself.)
 *
 * Fix: once a tool is sent deferred it latches for the session (same
 * pattern as the beta-header latches) and clears with
 * clearBetaHeaderLatches() on /clear and /compact.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clearBetaHeaderLatches,
  isLspDeferLatched,
  latchLspDefer,
} from 'src/bootstrap/state.js'

afterEach(() => {
  clearBetaHeaderLatches()
})

describe('LSP defer latch state', () => {
  test('not latched by default', () => {
    expect(isLspDeferLatched('LspDiagnostics')).toBe(false)
  })

  test('latching is per tool name and sticky', () => {
    latchLspDefer('LspDiagnostics')
    expect(isLspDeferLatched('LspDiagnostics')).toBe(true)
    expect(isLspDeferLatched('LspHover')).toBe(false)
    // Latching again is idempotent.
    latchLspDefer('LspDiagnostics')
    expect(isLspDeferLatched('LspDiagnostics')).toBe(true)
  })

  test('clearBetaHeaderLatches releases the latch (cache-cold moments: /clear, /compact)', () => {
    latchLspDefer('LspDiagnostics')
    latchLspDefer('LspHover')
    clearBetaHeaderLatches()
    expect(isLspDeferLatched('LspDiagnostics')).toBe(false)
    expect(isLspDeferLatched('LspHover')).toBe(false)
  })
})

describe('A3 regression: streaming.ts wiring', () => {
  test('shouldDeferLspTool consults and records the latch', () => {
    const source = readFileSync(join(import.meta.dir, 'streaming.ts'), 'utf8')
    // The latch is checked BEFORE the live initialization status...
    expect(source).toContain('isLspDeferLatched(tool.name)')
    // ...and recorded whenever a tool is actually deferred.
    expect(source).toContain('latchLspDefer(tool.name)')
  })
})
