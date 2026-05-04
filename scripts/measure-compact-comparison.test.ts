import { describe, expect, test } from 'bun:test'

import { measureCompactComparison } from './measure-compact-comparison.ts'

describe('measureCompactComparison', () => {
  test('produces N turns × M summaryRatios rows', async () => {
    const result = await measureCompactComparison({
      turns: [30, 60],
      summaryRatios: [0.05, 0.1, 0.15, 0.2],
    })
    expect(result.rows.length).toBe(2 * 4)
    for (const r of result.rows) {
      expect(r.microcompactTokens).toBeLessThan(r.baselineTokens)
      expect(r.fullCompactTokens).toBeLessThan(r.baselineTokens)
    }
  })

  test('within a turn group, /compact savings shrink as summaryRatio grows', async () => {
    const result = await measureCompactComparison({
      turns: [60],
      summaryRatios: [0.05, 0.1, 0.15, 0.2],
    })
    const sorted = result.rows.sort((a, b) => a.summaryRatio - b.summaryRatio)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.fullCompactSavingsTokens).toBeLessThan(
        sorted[i - 1]!.fullCompactSavingsTokens,
      )
    }
  })

  test('microcompact savings are constant across summaryRatio (independent paths)', async () => {
    const result = await measureCompactComparison({
      turns: [60],
      summaryRatios: [0.05, 0.1, 0.2],
    })
    const microSavings = new Set(result.rows.map(r => r.microcompactSavingsTokens))
    expect(microSavings.size).toBe(1)
  })

  test('upfront cost grows with summaryRatio (more output billed)', async () => {
    const result = await measureCompactComparison({
      turns: [60],
      summaryRatios: [0.05, 0.2],
    })
    const small = result.rows.find(r => r.summaryRatio === 0.05)!
    const big = result.rows.find(r => r.summaryRatio === 0.2)!
    expect(big.fullCompactUpfrontTokens).toBeGreaterThan(
      small.fullCompactUpfrontTokens,
    )
  })

  test('larger sessions have larger absolute savings at any summaryRatio', async () => {
    const result = await measureCompactComparison({
      turns: [30, 120],
      summaryRatios: [0.1],
    })
    const small = result.rows.find(r => r.turns === 30)!
    const big = result.rows.find(r => r.turns === 120)!
    expect(big.fullCompactSavingsTokens).toBeGreaterThan(
      small.fullCompactSavingsTokens,
    )
  })

  test('keep-recent only affects microcompact, not /compact', async () => {
    const a = await measureCompactComparison({
      turns: [30],
      summaryRatios: [0.1],
      keepRecent: 1,
    })
    const b = await measureCompactComparison({
      turns: [30],
      summaryRatios: [0.1],
      keepRecent: 5,
    })
    expect(b.rows[0]!.microcompactTokens).toBeGreaterThan(
      a.rows[0]!.microcompactTokens,
    )
    expect(b.rows[0]!.fullCompactTokens).toBe(a.rows[0]!.fullCompactTokens)
  })
})
