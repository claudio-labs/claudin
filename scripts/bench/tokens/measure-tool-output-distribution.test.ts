import { describe, expect, test } from 'bun:test'

import { measureToolOutputDistribution } from './measure-tool-output-distribution.ts'

describe('measureToolOutputDistribution', () => {
  test('produces one row per known tool with strictly ordered percentiles', async () => {
    const result = await measureToolOutputDistribution({ samples: 30 })

    const tools = result.rows.map(r => r.tool).sort()
    expect(tools).toEqual(['Bash', 'FileRead', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

    for (const r of result.rows) {
      expect(r.samples).toBe(30)
      expect(r.bytesMin).toBeLessThanOrEqual(r.bytesMedian)
      expect(r.bytesMedian).toBeLessThanOrEqual(r.bytesP95)
      expect(r.bytesP95).toBeLessThanOrEqual(r.bytesMax)
      expect(r.tokensMin).toBeLessThanOrEqual(r.tokensMedian)
      expect(r.tokensMedian).toBeLessThanOrEqual(r.tokensP95)
      expect(r.tokensP95).toBeLessThanOrEqual(r.tokensMax)
      expect(r.tokensTotal).toBeGreaterThan(0)
    }
  })

  test('totalTokens equals sum of per-tool tokensTotal', async () => {
    const result = await measureToolOutputDistribution({ samples: 20 })
    const sum = result.rows.reduce((acc, r) => acc + r.tokensTotal, 0)
    expect(result.totalTokens).toBe(sum)
  })

  test('different models scale tokens by bytes/token ratio', async () => {
    const claude = await measureToolOutputDistribution({
      model: 'claude-sonnet-4-5',
      samples: 20,
    })
    const gpt = await measureToolOutputDistribution({
      model: 'gpt-4o-2024-08-06',
      samples: 20,
    })
    expect(claude.bytesPerToken).toBe(3.5)
    expect(gpt.bytesPerToken).toBe(4)
    // Same body bytes → fewer tokens for higher bytes/token ratio.
    expect(gpt.totalTokens).toBeLessThan(claude.totalTokens)
  })

  test('output is deterministic across runs', async () => {
    const a = await measureToolOutputDistribution({ samples: 30 })
    const b = await measureToolOutputDistribution({ samples: 30 })
    expect(a.totalTokens).toBe(b.totalTokens)
    for (let i = 0; i < a.rows.length; i++) {
      expect(a.rows[i]!.tokensP95).toBe(b.rows[i]!.tokensP95)
    }
  })

  test('rows are sorted by tokensP95 descending', async () => {
    const result = await measureToolOutputDistribution({ samples: 20 })
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1]!.tokensP95).toBeGreaterThanOrEqual(
        result.rows[i]!.tokensP95,
      )
    }
  })
})
