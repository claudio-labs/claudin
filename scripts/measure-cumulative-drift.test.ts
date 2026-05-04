import { describe, expect, test } from 'bun:test'

import { measureCumulativeDrift } from './measure-cumulative-drift.ts'

describe('measureCumulativeDrift', () => {
  test('billed cumulative is monotonically increasing', async () => {
    const result = await measureCumulativeDrift({ turns: [1, 5, 10, 20, 50] })
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i]!.billedTotal).toBeGreaterThan(
        result.rows[i - 1]!.billedTotal,
      )
    }
  })

  test('cache breaks count grows with break-every cadence', async () => {
    const result = await measureCumulativeDrift({
      turns: [1, 21, 41, 61],
      breakEvery: 20,
    })
    const t1 = result.rows.find(r => r.turns === 1)!
    const t21 = result.rows.find(r => r.turns === 21)!
    const t41 = result.rows.find(r => r.turns === 41)!
    const t61 = result.rows.find(r => r.turns === 61)!
    expect(t1.cacheBreaks).toBe(0)
    expect(t21.cacheBreaks).toBe(1)
    expect(t41.cacheBreaks).toBe(2)
    expect(t61.cacheBreaks).toBe(3)
  })

  test('history tokens shrink after microcompact threshold', async () => {
    // With a fat tool_result (8 KB) the threshold (~50 KB) trips around turn
    // 6-8; after that the history should be smaller than a naive linear
    // accumulation.
    const result = await measureCumulativeDrift({
      turns: [3, 50],
      toolResultKB: 8,
    })
    const t3 = result.rows.find(r => r.turns === 3)!
    const t50 = result.rows.find(r => r.turns === 50)!
    // After 50 turns with 8 KB results and microcompact, history should be
    // far less than 50× the per-turn pair size.
    const naiveLinearAt50 = (t3.historyTokens / 3) * 50
    expect(t50.historyTokens).toBeLessThan(naiveLinearAt50)
  })

  test('budget crossings are discovered in increasing order', async () => {
    const result = await measureCumulativeDrift({
      turns: [1, 100],
      breakEvery: 20,
    })
    const reached = result.budgetCrossings
      .map(c => c.turnsToReach)
      .filter((t): t is number => t !== null)
    for (let i = 1; i < reached.length; i++) {
      expect(reached[i]!).toBeGreaterThanOrEqual(reached[i - 1]!)
    }
  })

  test('higher cache-break frequency → higher billed cumulative at same turn', async () => {
    const stable = await measureCumulativeDrift({
      turns: [50],
      breakEvery: 100,
    })
    const churny = await measureCumulativeDrift({
      turns: [50],
      breakEvery: 5,
    })
    const stableTotal = stable.rows[0]!.billedTotal
    const churnyTotal = churny.rows[0]!.billedTotal
    expect(churnyTotal).toBeGreaterThan(stableTotal)
  })
})
