import { describe, expect, test } from 'bun:test'

import { KEEP_RECENT_INPUT_RESULTS } from 'src/agent/compact/stableStubState/clipFrontier.js'
import { getModelCosts } from 'src/providers/usage/modelCost.js'
import { parseArgs, PRICE, simulate, type Args, type Thread } from './relief-ceiling-sim'

const BASE: Args = parseArgs(['--main'])

// Ten calls growing 10k each, one 9k clearable result per call: a 70k
// trigger is crossed at call 7, where the blocks of calls 0–4 sit outside the
// last two calls. The band is min(max(60k, 10.5k), 21k) = 21k → target 49k.
const THREAD: Thread = {
  name: 't',
  ctx: Array.from({ length: 10 }, (_, i) => (i + 1) * 10_000),
  blocks: Array.from({ length: 10 }, (_, call) => ({ call, tokens: 9_000 })),
}

describe('parseArgs', () => {
  test('--clip-all and --band are off by default and read when given', () => {
    expect(BASE).toMatchObject({ main: true, clipAll: false, band: null })
    expect(parseArgs(['--clip-all', '--band=190000'])).toMatchObject({ clipAll: true, band: 190_000 })
  })

  test('a band that is not a positive number is an error', () => {
    expect(() => parseArgs(['--band=x'])).toThrow('--band')
    expect(() => parseArgs(['--band=0'])).toThrow('--band')
  })

  test('--input-keep defaults to the policy (10) and rejects a non-count', () => {
    expect(BASE.inputKeep).toBe(KEEP_RECENT_INPUT_RESULTS)
    expect(parseArgs(['--input-keep=2']).inputKeep).toBe(2)
    expect(() => parseArgs(['--input-keep=x'])).toThrow('--input-keep')
    expect(() => parseArgs(['--input-keep=-1'])).toThrow('--input-keep')
  })

  test('prices are Opus 5.5 as modelCost.ts has them', () => {
    const app = getModelCosts('claude-opus-5-5', { input_tokens: 1, output_tokens: 1 } as never)
    expect(PRICE).toEqual({
      read: app.promptCacheReadTokens,
      write5m: app.promptCacheWriteTokens,
      write1h: app.promptCacheWrite1hTokens,
      output: app.outputTokens,
    })
  })
})

describe('simulate', () => {
  test('one event picks one band oldest first; --clip-all picks every block outside the last two calls', () => {
    const band = simulate(THREAD, 70_000, BASE)
    const all = simulate(THREAD, 70_000, { ...BASE, clipAll: true })
    expect(band.events).toBe(1)
    expect(all.events).toBe(1)
    // Same first clipped block, so the same cached prefix: the extra clips
    // only shrink what is written again, and free more for every later call.
    expect(all.rewrite).toBeLessThan(band.rewrite)
    expect(all.saved).toBeGreaterThan(band.saved)
  })

  test('--clip-all never touches the last two calls: with only those clearable, the event starves', () => {
    const recentOnly: Thread = { ...THREAD, blocks: [{ call: 8, tokens: 50_000 }, { call: 9, tokens: 50_000 }] }
    const o = simulate(recentOnly, 70_000, { ...BASE, clipAll: true })
    expect(o.events).toBe(0)
    expect(o.starved).toBeGreaterThan(0)
  })

  test('--band replaces the formula: a wider band clips more on the first event', () => {
    const formula = simulate(THREAD, 70_000, BASE)
    const wide = simulate(THREAD, 70_000, { ...BASE, band: 40_000 })
    expect(wide.saved).toBeGreaterThan(formula.saved)
  })

  test('inputs keep the last --input-keep calls, results only the last two', () => {
    // Inputs only, on calls 4..7: the 70k trigger is crossed at call 7, where
    // all four sit outside the result window but inside an input window of 10.
    const inputs: Thread = { ...THREAD, blocks: [4, 5, 6, 7].map(call => ({ call, tokens: 30_000, input: true })) }
    expect(simulate(inputs, 70_000, { ...BASE, clipAll: true }).events).toBe(0)
    expect(simulate(inputs, 70_000, { ...BASE, clipAll: true, inputKeep: 2 }).events).toBeGreaterThan(0)
  })
})
