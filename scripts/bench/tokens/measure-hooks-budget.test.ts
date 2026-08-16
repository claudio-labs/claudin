import { describe, expect, test } from 'bun:test'

import { measureHooksBudget } from './measure-hooks-budget.ts'

describe('measureHooksBudget', () => {
  test('emits one row per (profile, hookType) combination', async () => {
    const result = await measureHooksBudget()
    const profiles = new Set(result.rows.map(r => r.profile))
    expect(profiles.size).toBe(3)
    const types = new Set(result.rows.map(r => r.hookType))
    expect(types.size).toBeGreaterThanOrEqual(5)
    for (const r of result.rows) {
      expect(r.bytes).toBeGreaterThan(0)
      expect(r.tokens).toBeGreaterThan(0)
      expect(r.envelopeOverheadBytes).toBeGreaterThan(0)
      expect(r.envelopeOverheadBytes).toBeLessThan(50) // wrap is small
    }
  })

  test('larger profile yields larger byte counts', async () => {
    const result = await measureHooksBudget()
    // Find any (hookType, profile) pair and compare across profiles.
    const small = result.rows.find(
      r => r.profile === 'small' && r.hookType === 'hook_blocking_error',
    )!
    const typical = result.rows.find(
      r => r.profile === 'typical' && r.hookType === 'hook_blocking_error',
    )!
    const large = result.rows.find(
      r => r.profile === 'large' && r.hookType === 'hook_blocking_error',
    )!
    expect(typical.bytes).toBeGreaterThan(small.bytes)
    expect(large.bytes).toBeGreaterThan(typical.bytes)
  })

  test('per-turn typical projection scales linearly with hooksPerTurn', async () => {
    const a = await measureHooksBudget({ hooksPerTurn: 1, turns: 1 })
    const b = await measureHooksBudget({ hooksPerTurn: 4, turns: 1 })
    expect(b.perTurnTokensTypical).toBe(a.perTurnTokensTypical * 4)
  })

  test('projected tokens scale linearly with turns', async () => {
    const short = await measureHooksBudget({ hooksPerTurn: 2, turns: 10 })
    const long = await measureHooksBudget({ hooksPerTurn: 2, turns: 50 })
    expect(long.projectedTokens).toBe(short.projectedTokens * 5)
  })

  test('envelope overhead is identical across all rows (constant wrapper)', async () => {
    const result = await measureHooksBudget()
    const overheads = new Set(result.rows.map(r => r.envelopeOverheadBytes))
    expect(overheads.size).toBe(1)
  })
})
