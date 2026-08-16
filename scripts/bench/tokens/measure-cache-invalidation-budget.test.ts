import { describe, expect, test } from 'bun:test'

import { measureCacheInvalidation } from './measure-cache-invalidation-budget.ts'

describe('measureCacheInvalidation', () => {
  test('produces all known break scenarios with consistent math', async () => {
    const result = await measureCacheInvalidation({
      engine: 'anthropic',
      model: 'claude-sonnet-4-5',
    })

    expect(result.engine).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-5')
    expect(result.bytesPerToken).toBe(3.5)

    expect(result.scenarios.length).toBeGreaterThanOrEqual(7)
    const ccWorkloadRow = result.scenarios.find(s =>
      s.scenario.includes('cc_workload flip'),
    )
    expect(ccWorkloadRow).toBeDefined()
    // Post-fix: cc_workload no longer enters the cached prefix, so the
    // flip rebills 0 tokens. If this jumps back up, someone re-inlined
    // the workload tag into the attribution header (system.ts).
    expect(ccWorkloadRow!.rebillTokens).toBe(0)

    for (const row of result.scenarios) {
      expect(row.cachedPrefixBytes).toBeGreaterThanOrEqual(0)
      expect(row.rebillTokens).toBeGreaterThanOrEqual(0)
      // hit < rebill on positive prefixes (1h discount is steeper)
      if (row.rebillTokens > 0) {
        expect(row.hitTokens5m).toBeLessThan(row.rebillTokens)
        expect(row.hitTokens1h).toBeLessThan(row.rebillTokens)
        expect(row.hitTokens1h).toBeLessThanOrEqual(row.hitTokens5m)
      }
      expect(row.breakCostTokens5m).toBe(row.rebillTokens - row.hitTokens5m)
      expect(row.breakCostTokens1h).toBe(row.rebillTokens - row.hitTokens1h)
    }
  })

  test('sticky/no-break scenarios cost 0 tokens', async () => {
    const result = await measureCacheInvalidation()
    const noBreak = result.scenarios.filter(s =>
      s.scenario.includes('no break'),
    )
    expect(noBreak.length).toBeGreaterThan(0)
    for (const r of noBreak) {
      expect(r.cachedPrefixBytes).toBe(0)
      expect(r.rebillTokens).toBe(0)
      expect(r.breakCostTokens5m).toBe(0)
      expect(r.breakCostTokens1h).toBe(0)
    }
  })

  test('any breaking scenario costs at least 1000 tokens (system+tools is non-trivial)', async () => {
    const result = await measureCacheInvalidation()
    const breaking = result.scenarios.filter(s => s.rebillTokens > 0)
    expect(breaking.length).toBeGreaterThan(0)
    for (const r of breaking) {
      expect(r.rebillTokens).toBeGreaterThan(1000)
    }
  })

  test('result is sorted by 5m break cost descending', async () => {
    const result = await measureCacheInvalidation()
    for (let i = 1; i < result.scenarios.length; i++) {
      expect(result.scenarios[i - 1]!.breakCostTokens5m).toBeGreaterThanOrEqual(
        result.scenarios[i]!.breakCostTokens5m,
      )
    }
  })

  test('engine choice changes prefix size (different schema shape)', async () => {
    const a = await measureCacheInvalidation({ engine: 'anthropic' })
    const o = await measureCacheInvalidation({ engine: 'openai' })
    const aFull = a.scenarios.find(s => s.scenario === 'add 1 tool (e.g. new MCP)')!
    const oFull = o.scenarios.find(s => s.scenario === 'add 1 tool (e.g. new MCP)')!
    expect(aFull.rebillTokens).not.toBe(oFull.rebillTokens)
  })
})
