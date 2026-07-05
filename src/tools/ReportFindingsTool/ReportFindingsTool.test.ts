import { describe, expect, test } from 'bun:test'

import { MAX_FINDINGS } from './constants.js'
import { ReportFindingsTool } from './ReportFindingsTool.js'

function finding(over: Record<string, unknown> = {}) {
  return {
    file: 'src/foo.ts',
    summary: 'off-by-one in loop bound',
    failure_scenario: 'input length N → reads index N, out of bounds',
    ...over,
  }
}

// The built Tool.call widens to (args, ctx, canUseTool, parentMessage,
// onProgress?); this review-only tool reads only `args`, so stub the rest.
function callReport(input: Record<string, unknown>) {
  return ReportFindingsTool.call(
    input as never,
    {} as never,
    {} as never,
    {} as never,
  )
}

describe('ReportFindingsTool', () => {
  test('flags: read-only, concurrency-safe, enabled, deferred', () => {
    expect(ReportFindingsTool.isReadOnly?.({ findings: [] })).toBe(true)
    expect(ReportFindingsTool.isConcurrencySafe?.({ findings: [] })).toBe(true)
    expect(ReportFindingsTool.isEnabled?.()).toBe(true)
    // Review-only: kept out of the base tool schema, loaded via ToolSearch.
    expect(ReportFindingsTool.shouldDefer).toBe(true)
  })

  test('input schema accepts an empty findings array', () => {
    const ok = ReportFindingsTool.inputSchema.safeParse({ findings: [] })
    expect(ok.success).toBe(true)
  })

  test('input schema requires file, summary, failure_scenario', () => {
    const missing = ReportFindingsTool.inputSchema.safeParse({
      findings: [{ file: 'a.ts', summary: 'x' }],
    })
    expect(missing.success).toBe(false)

    const ok = ReportFindingsTool.inputSchema.safeParse({
      findings: [finding()],
    })
    expect(ok.success).toBe(true)
  })

  test('input schema rejects unknown per-finding keys (strict)', () => {
    const extra = ReportFindingsTool.inputSchema.safeParse({
      findings: [finding({ severity: 'high' })],
    })
    expect(extra.success).toBe(false)
  })

  test('input schema enforces the MAX_FINDINGS cap', () => {
    const tooMany = ReportFindingsTool.inputSchema.safeParse({
      findings: Array.from({ length: MAX_FINDINGS + 1 }, () => finding()),
    })
    expect(tooMany.success).toBe(false)
  })

  test('input schema validates verdict / outcome / level enums', () => {
    const badVerdict = ReportFindingsTool.inputSchema.safeParse({
      findings: [finding({ verdict: 'MAYBE' })],
    })
    expect(badVerdict.success).toBe(false)

    const badLevel = ReportFindingsTool.inputSchema.safeParse({
      findings: [finding()],
      level: 'ultra',
    })
    expect(badLevel.success).toBe(false)

    const ok = ReportFindingsTool.inputSchema.safeParse({
      findings: [finding({ verdict: 'CONFIRMED', outcome: 'fixed' })],
      level: 'high',
    })
    expect(ok.success).toBe(true)
  })

  test('toAutoClassifierInput summarises the count', () => {
    expect(
      ReportFindingsTool.toAutoClassifierInput?.({
        findings: [finding(), finding()],
      } as never),
    ).toBe('2 findings')
  })

  test('call() echoes findings and includes level only when set', async () => {
    const withLevel = await callReport({
      findings: [finding()],
      level: 'medium',
    })
    expect(withLevel.data.findings).toHaveLength(1)
    expect(withLevel.data.level).toBe('medium')

    const noLevel = await callReport({ findings: [] })
    expect('level' in noLevel.data).toBe(false)
  })

  test('mapToolResultToToolResultBlockParam reports count and empty case', () => {
    const some = ReportFindingsTool.mapToolResultToToolResultBlockParam?.(
      { findings: [finding()] },
      'u1',
    )
    expect(some?.content).toContain('Reported 1 finding')
    expect(some?.content).not.toContain('1 findings')

    const none = ReportFindingsTool.mapToolResultToToolResultBlockParam?.(
      { findings: [] },
      'u2',
    )
    expect(none?.content).toContain('none survived')
  })
})
