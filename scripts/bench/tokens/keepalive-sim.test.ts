import { describe, expect, test } from 'bun:test'
import {
  contextOf,
  endPingsUsd,
  netOf,
  parseArgs,
  planGap,
  simulateThread,
  spendOf,
  tailEstimate,
  type Call,
  type Rates,
} from './keepalive-sim.ts'

// Round numbers: a 1h write is 10 reads, so every dollar below is tokens / 1M
// times 1 (read) or 9 (a write that became a read).
const RATES: Rates = { input: 3, write5m: 5, write1h: 10, read: 1, output: 20 }
const rateOf = (): Rates => RATES
const K1 = { maxPings: 1, pingMin: 55 }
const K3 = { maxPings: 3, pingMin: 55 }

/** A call at minute `min` with `ctx` tokens of context, `write` of them written. */
function call(min: number, ctx: number, write = 1_000, extra: Partial<Call> = {}): Call {
  return { atMs: min * 60_000, model: 'm', input: 0, read: ctx - write, write5m: 0, write1h: write, output: 0, ...extra }
}

// Three calls a minute apart, a 70-minute gap, then the thread as recorded:
// the idle-gap clip took 22k (102k → 80k) and the call after the gap wrote all
// 80k. Two more calls read on, and the fourth is a relief clip (82k → 60k).
const SEVENTY: Call[] = [
  call(0, 100_000),
  call(1, 101_000),
  call(2, 102_000),
  call(72, 80_000, 80_000),
  call(73, 81_000),
  call(74, 82_000),
  call(75, 60_000, 60_000),
  call(76, 61_000),
]

describe('planGap', () => {
  test('pings every 55 minutes up to K, and the cache is warm for 60 after the last', () => {
    expect(planGap(54, K3)).toEqual({ pings: 0, expired: false, covered: false })
    expect(planGap(58, K3)).toEqual({ pings: 1, expired: false, covered: false })
    expect(planGap(70, K1)).toEqual({ pings: 1, expired: true, covered: true })
    expect(planGap(115, K1)).toEqual({ pings: 1, expired: true, covered: true })
    expect(planGap(116, K1)).toEqual({ pings: 1, expired: true, covered: false })
    expect(planGap(200, K3)).toEqual({ pings: 3, expired: true, covered: true })
    expect(planGap(226, K3)).toEqual({ pings: 3, expired: true, covered: false })
  })
})

describe('tailEstimate', () => {
  test('the median write of the calls that follow a gap under 5 minutes', () => {
    // After short gaps: 1k, 1k, 1k, 1k, 60k, 1k. The 80k rewrite follows the long gap.
    expect(tailEstimate(SEVENTY)).toBe(1_000)
    expect(tailEstimate([call(0, 10_000), call(30, 10_000)])).toBe(0)
  })
})

describe('simulateThread', () => {
  test('a 70-minute gap under K=1: the rewrite is avoided, one ping, extra reads until the reset', () => {
    const o = simulateThread(SEVENTY, K1, rateOf)
    expect(o).toMatchObject({ expiries: 1, rewrote: 1, covered: 1, usefulPings: 1, wastedPings: 0, compacted: 0 })
    // 80k written − 1k tail = 79k that are read instead of written: × (10 − 1).
    expect(o.avoidedUsd).toBeCloseTo(0.711, 6)
    // One read of the 102k context before the gap.
    expect(o.pingUsd).toBeCloseTo(0.102, 6)
    // 22k un-clipped tokens on the three calls before the relief clip.
    expect(o.extraReadUsd).toBeCloseTo(0.066, 6)
    expect(netOf(o)).toBeCloseTo(0.543, 6)
    expect(o.gaps).toEqual([
      { gapMin: 70, pings: 1, before: 102_000, after: 80_000, tail: 1_000, tokensAvoided: 79_000, callsUntilReset: 3 },
    ])
  })

  test('without the 20% drop the extra reads run to the end of the thread', () => {
    const steady = [...SEVENTY.slice(0, 6), call(75, 83_000), call(76, 84_000)]
    const o = simulateThread(steady, K1, rateOf)
    expect(o.extraReadUsd).toBeCloseTo(0.11, 6)
    expect(o.gaps[0]!.callsUntilReset).toBe(5)
  })

  test('a drop under 20% is not a reset', () => {
    const dip = [...SEVENTY.slice(0, 6), call(75, 66_000), call(76, 67_000)]
    expect(simulateThread(dip, K1, rateOf).gaps[0]!.callsUntilReset).toBe(5)
  })

  test('a 200-minute gap: K=1 wastes its ping, K=3 covers it with three', () => {
    const thread = [call(0, 100_000), call(1, 100_000), call(201, 90_000, 90_000), call(202, 91_000)]
    const one = simulateThread(thread, K1, rateOf)
    expect(one).toMatchObject({ expiries: 1, covered: 0, usefulPings: 0, wastedPings: 1, avoidedUsd: 0, extraReadUsd: 0 })
    expect(one.pingUsd).toBeCloseTo(0.1, 6)
    expect(netOf(one)).toBeCloseTo(-0.1, 6)

    const three = simulateThread(thread, K3, rateOf)
    expect(three).toMatchObject({ expiries: 1, covered: 1, usefulPings: 3, wastedPings: 0 })
    expect(three.pingUsd).toBeCloseTo(0.3, 6)
    expect(three.avoidedUsd).toBeCloseTo((89_000 * 9) / 1e6, 6)
    // 10k un-clipped on the two calls after the gap.
    expect(three.extraReadUsd).toBeCloseTo(0.02, 6)
  })

  test('a 58-minute gap is one wasted ping and no saving', () => {
    const o = simulateThread([call(0, 100_000), call(58, 101_000), call(59, 102_000)], K3, rateOf)
    expect(o).toMatchObject({ expiries: 0, covered: 0, usefulPings: 0, wastedPings: 1, avoidedUsd: 0, extraReadUsd: 0 })
    expect(o.pingUsd).toBeCloseTo(0.1, 6)
  })

  test('a gap under the ping time changes nothing', () => {
    const o = simulateThread([call(0, 100_000), call(54, 101_000)], K3, rateOf)
    expect(o).toMatchObject({ expiries: 0, usefulPings: 0, wastedPings: 0, pingUsd: 0, avoidedUsd: 0, extraReadUsd: 0 })
  })

  test('a context that grew across the gap adds no extra reads', () => {
    const grew = [call(0, 100_000), call(1, 100_000), call(71, 120_000, 120_000), call(72, 121_000), call(73, 122_000)]
    const o = simulateThread(grew, K1, rateOf)
    expect(o.covered).toBe(1)
    expect(o.avoidedUsd).toBeCloseTo((119_000 * 9) / 1e6, 6)
    expect(o.extraReadUsd).toBe(0)
    expect(o.gaps[0]!.callsUntilReset).toBe(3)
  })

  test('a later gap the policy does not cover ends the extra reads; one it covers adds to them', () => {
    const tail = [call(73, 81_000), call(74, 82_000)]
    // 300 minutes: beyond K=1, so the prefix expires and is clipped there.
    const uncovered = [...SEVENTY.slice(0, 4), ...tail, call(374, 70_000, 70_000), call(375, 71_000)]
    const u = simulateThread(uncovered, K1, rateOf)
    expect(u).toMatchObject({ expiries: 2, covered: 1, usefulPings: 1, wastedPings: 1 })
    expect(u.extraReadUsd).toBeCloseTo(0.066, 6)
    expect(u.gaps[0]!.callsUntilReset).toBe(3)

    // 80 minutes: covered again, and its own 12k clip rides with the first 22k.
    const covered = [...SEVENTY.slice(0, 4), ...tail, call(154, 70_000, 70_000), call(155, 71_000)]
    const c = simulateThread(covered, K1, rateOf)
    expect(c).toMatchObject({ expiries: 2, covered: 2, usefulPings: 2, wastedPings: 0 })
    expect(c.extraReadUsd).toBeCloseTo((3 * 22_000 + 2 * 34_000) / 1e6, 6)
    expect(c.gaps.map(g => g.callsUntilReset)).toEqual([5, 2])
  })

  test('a compaction inside a covered gap: the pings, no saving, no extra reads, and a reset', () => {
    const compacted = [...SEVENTY.slice(0, 6), call(150, 30_000, 30_000, { afterCompact: true }), call(151, 31_000)]
    const o = simulateThread(compacted, K1, rateOf)
    expect(o).toMatchObject({ expiries: 2, covered: 2, compacted: 1, usefulPings: 2 })
    // Only the first gap saves, and its extra reads stop at the boundary.
    expect(o.avoidedUsd).toBeCloseTo(0.711, 6)
    expect(o.extraReadUsd).toBeCloseTo(0.066, 6)
    expect(o.gaps).toHaveLength(1)
  })

  test('a write no larger than the tail saves nothing', () => {
    // Something else read the prefix during the gap: the next call wrote its tail only.
    const warm = [call(0, 100_000), call(1, 100_000), call(71, 101_000), call(72, 102_000)]
    const o = simulateThread(warm, K1, rateOf)
    expect(o).toMatchObject({ expiries: 1, rewrote: 0, covered: 1, avoidedUsd: 0, extraReadUsd: 0 })
  })

  test('each term is priced by the call that pays it', () => {
    const byModel = (c: Call): Rates => (c.model === 'dear' ? { ...RATES, write1h: 20, read: 2 } : RATES)
    const thread = SEVENTY.map((c, i) => (i >= 3 ? { ...c, model: 'dear' } : c))
    const o = simulateThread(thread, K1, byModel)
    expect(o.pingUsd).toBeCloseTo(0.102, 6)
    expect(o.avoidedUsd).toBeCloseTo((79_000 * 18) / 1e6, 6)
    expect(o.extraReadUsd).toBeCloseTo(0.132, 6)
  })
})

describe('spendOf and endPingsUsd', () => {
  test('spend is every token class at its own rate', () => {
    const c: Call = { atMs: 0, model: 'm', input: 1_000_000, read: 2_000_000, write5m: 100_000, write1h: 200_000, output: 50_000 }
    expect(contextOf(c)).toBe(3_300_000)
    expect(spendOf([c], rateOf)).toBeCloseTo(3 + 2 + 0.5 + 2 + 1, 6)
  })

  test('the pings after the last call: up to K, and none the clock has not reached', () => {
    const thread = [call(0, 100_000), call(1, 200_000)]
    expect(endPingsUsd(thread, K3, rateOf, 1_000 * 60_000)).toBeCloseTo(0.6, 6)
    expect(endPingsUsd(thread, K3, rateOf, 112 * 60_000)).toBeCloseTo(0.4, 6)
    expect(endPingsUsd(thread, K3, rateOf, 30 * 60_000)).toBe(0)
    expect(endPingsUsd([], K3, rateOf, 0)).toBe(0)
  })
})

describe('parseArgs', () => {
  test('defaults to the last 7 days and a ping at 55 minutes', () => {
    const now = Date.parse('2026-11-11T12:00:00Z')
    expect(parseArgs([], now)).toEqual({ since: now - 7 * 24 * 60 * 60 * 1000, exclude: [], as: [], pingMin: 55 })
  })

  test('--exclude and --as repeat', () => {
    const a = parseArgs(['--since=2026-11-04', '--exclude=d44cf59f', '--exclude=abc', '--as=claude-opus-5-5', '--as=claude-fable-5-2', '--ping-min=50'])
    expect(a).toEqual({
      since: Date.parse('2026-11-04T00:00:00Z'),
      exclude: ['d44cf59f', 'abc'],
      as: ['claude-opus-5-5', 'claude-fable-5-2'],
      pingMin: 50,
    })
  })

  test('a date that is not one and a ping at or past the TTL are errors', () => {
    expect(() => parseArgs(['--since=yesterday'])).toThrow('--since')
    expect(() => parseArgs(['--ping-min=60'])).toThrow('--ping-min')
    expect(() => parseArgs(['--ping-min=0'])).toThrow('--ping-min')
    expect(() => parseArgs(['--ping-min=x'])).toThrow('--ping-min')
  })
})
