import { describe, expect, test } from 'bun:test'

import { measureLspDiagnosticBudget } from './measure-lsp-diagnostic-budget.ts'

describe('measureLspDiagnosticBudget', () => {
  test('produces a row per requested variant with sane numbers', async () => {
    const result = await measureLspDiagnosticBudget({
      files: 5,
      diagsPerFile: 4,
      variants: ['ts', 'rust', 'go'],
    })
    expect(result.rows).toHaveLength(3)
    for (const r of result.rows) {
      expect(r.rawBytes).toBeGreaterThan(0)
      expect(r.wireBytes).toBeGreaterThan(r.formattedBytes)
      expect(r.wireTokens).toBeGreaterThan(0)
    }
  })

  test('TS messages produce more bytes than Go for identical file/diag counts', async () => {
    const result = await measureLspDiagnosticBudget({
      files: 5,
      diagsPerFile: 4,
      variants: ['ts', 'go'],
    })
    const ts = result.rows.find(r => r.variant === 'ts')!
    const go = result.rows.find(r => r.variant === 'go')!
    expect(ts.wireBytes).toBeGreaterThan(go.wireBytes)
  })

  test('truncation cap fires for pathological volume and bytesLost > 0', async () => {
    const result = await measureLspDiagnosticBudget({
      files: 50,
      diagsPerFile: 20,
      messageBytes: 200,
      variants: ['ts'],
    })
    const r = result.rows[0]!
    expect(r.truncated).toBe(true)
    // Cap is 4000 *chars* (formatter slices on .length). UTF-8 bytes can
    // overshoot slightly because the ❌/⚠ severity glyphs are multi-byte —
    // give a small grace margin.
    expect(r.formattedBytes).toBeLessThanOrEqual(4100)
    expect(r.bytesLostToTruncation).toBeGreaterThan(1000)
  })

  test('small fixture stays under the truncation cap', async () => {
    const result = await measureLspDiagnosticBudget({
      files: 2,
      diagsPerFile: 2,
      messageBytes: 60,
      variants: ['ts'],
    })
    const r = result.rows[0]!
    expect(r.truncated).toBe(false)
    expect(r.bytesLostToTruncation).toBe(0)
  })

  test('total wire bytes equals the row sum', async () => {
    const result = await measureLspDiagnosticBudget({})
    expect(result.totalWireBytes).toBe(
      result.rows.reduce((acc, r) => acc + r.wireBytes, 0),
    )
    expect(result.totalWireTokens).toBe(
      result.rows.reduce((acc, r) => acc + r.wireTokens, 0),
    )
  })
})
