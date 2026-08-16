import { describe, expect, test } from 'bun:test'

import { measureMicrocompactSavings } from './measure-microcompact-savings.ts'

describe('measureMicrocompactSavings', () => {
  test('reports savings for every requested session size', async () => {
    const result = await measureMicrocompactSavings({
      turns: [10, 30],
      avgToolResultKB: 2,
      keepRecent: 2,
    })
    expect(result.rows).toHaveLength(2)
    for (const r of result.rows) {
      expect(r.baselineTokens).toBeGreaterThan(0)
      expect(r.compressedTokens).toBeGreaterThan(0)
      // applyStableStubs is a strict reduction for fat tool_results.
      expect(r.compressedTokens).toBeLessThan(r.baselineTokens)
      expect(r.tokensSaved).toBe(r.baselineTokens - r.compressedTokens)
      expect(r.tokensPctSaved).toBeGreaterThan(0)
      expect(r.bytesSaved).toBe(r.baselineBytes - r.compressedBytes)
      expect(r.clippedCount).toBeGreaterThan(0)
    }
  })

  test('savings grow (in absolute and percentage) with session size', async () => {
    const result = await measureMicrocompactSavings({
      turns: [10, 30, 60],
      avgToolResultKB: 4,
    })
    const [a, b, c] = result.rows
    expect(a!.tokensSaved).toBeLessThan(b!.tokensSaved)
    expect(b!.tokensSaved).toBeLessThan(c!.tokensSaved)
    // Percent saved should also increase as the un-clipped tail becomes a
    // smaller share of the conversation.
    expect(a!.tokensPctSaved).toBeLessThan(c!.tokensPctSaved)
  })

  test('keep-recent controls how many tool_results stay un-clipped', async () => {
    const keepFew = await measureMicrocompactSavings({
      turns: [30],
      keepRecent: 1,
    })
    const keepMany = await measureMicrocompactSavings({
      turns: [30],
      keepRecent: 10,
    })
    expect(keepFew.rows[0]!.clippedCount).toBeGreaterThan(
      keepMany.rows[0]!.clippedCount,
    )
    expect(keepFew.rows[0]!.tokensSaved).toBeGreaterThan(
      keepMany.rows[0]!.tokensSaved,
    )
  })

  test('larger tool results yield larger savings', async () => {
    const small = await measureMicrocompactSavings({ turns: [30], avgToolResultKB: 1 })
    const big = await measureMicrocompactSavings({ turns: [30], avgToolResultKB: 8 })
    expect(big.rows[0]!.tokensSaved).toBeGreaterThan(small.rows[0]!.tokensSaved)
  })
})
