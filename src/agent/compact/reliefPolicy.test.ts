import { afterEach, describe, expect, test } from 'bun:test'

import {
  decideRelief,
  isReliefWindowLaneEnabled,
  reliefMargin,
  reliefTrigger,
  selectReliefIds,
  RELIEF_MARGIN_MAX_TOKENS,
  RELIEF_MARGIN_MIN_TOKENS,
  type ReliefInput,
  type ReliefProfile,
} from 'src/agent/compact/reliefPolicy.js'
import { AGGRESSIVE_PROFILE, RETAIN_PROFILE } from 'src/agent/cache/cacheProfile.js'

const retain: ReliefProfile = RETAIN_PROFILE
const aggressive: ReliefProfile = AGGRESSIVE_PROFILE

// A 200k model: window minus 20k summary reserve, autocompact 13k below that.
const WINDOW_200K = 180_000
const AUTOCOMPACT_200K = 167_000
// A 1M model.
const WINDOW_1M = 980_000
const AUTOCOMPACT_1M = 967_000

function input(over: Partial<ReliefInput>): ReliefInput {
  return {
    usedTokens: 0,
    effectiveWindow: WINDOW_200K,
    autocompactThreshold: AUTOCOMPACT_200K,
    retainedFullResultTokens: 0,
    profile: retain,
    windowLaneEnabled: true,
    ...over,
  }
}

describe('reliefMargin', () => {
  test('scales with the window inside [5k, 20k]', () => {
    expect(reliefMargin(40_000)).toBe(RELIEF_MARGIN_MIN_TOKENS)
    expect(reliefMargin(100_000)).toBe(10_000)
    expect(reliefMargin(WINDOW_1M)).toBe(RELIEF_MARGIN_MAX_TOKENS)
  })
})

describe('reliefTrigger', () => {
  test('200k retain: the fraction wins (135k < autocompact − 18k)', () => {
    expect(reliefTrigger(WINDOW_200K, AUTOCOMPACT_200K, 0.75)).toBe(135_000)
  })

  test('small window: the autocompact cap wins so the clip pre-empts the wipe', () => {
    // 40k effective → autocompact 27k, margin 5k → cap 22k < 0.75 × 40k
    expect(reliefTrigger(40_000, 27_000, 0.75)).toBe(22_000)
  })

  test('autocompact disabled → pure fraction', () => {
    expect(reliefTrigger(WINDOW_200K, null, 0.75)).toBe(135_000)
  })

  test('degenerate cap (≤ 0) falls back to the fraction instead of disabling the lane', () => {
    expect(reliefTrigger(20_000, 3_000, 0.5)).toBe(10_000)
  })

  test('unknown window → 0 (lane off)', () => {
    expect(reliefTrigger(0, AUTOCOMPACT_200K, 0.75)).toBe(0)
  })
})

describe('decideRelief — window lane', () => {
  test('below the trigger: none', () => {
    expect(decideRelief(input({ usedTokens: 134_999 }))).toEqual({ kind: 'none' })
  })

  test('above the trigger: clip down to trigger − band (60k clamped to 30% of 135k)', () => {
    const d = decideRelief(input({ usedTokens: 140_000 }))
    expect(d).toEqual({
      kind: 'clip',
      lane: 'window',
      tokensToFree: 45_500,
      trigger: 135_000,
      target: 94_500,
    })
  })

  test('1M retain: trigger at 0.75 × window, band stays 60k', () => {
    const d = decideRelief(
      input({
        usedTokens: 800_000,
        effectiveWindow: WINDOW_1M,
        autocompactThreshold: AUTOCOMPACT_1M,
      }),
    )
    expect(d).toMatchObject({ lane: 'window', trigger: 735_000, target: 675_000 })
  })

  test('band is clamped to 30% of the trigger on small windows', () => {
    // 40k window → trigger 22k → band min(60k, 6.6k)
    const d = decideRelief(
      input({ usedTokens: 25_000, effectiveWindow: 40_000, autocompactThreshold: 27_000 }),
    )
    expect(d).toMatchObject({ lane: 'window', trigger: 22_000, target: 15_400 })
  })

  test('aggressive profile triggers at 0.5', () => {
    const d = decideRelief(input({ usedTokens: 95_000, profile: aggressive }))
    expect(d).toMatchObject({ lane: 'window', trigger: 90_000 })
  })

  test('killswitch: the window lane never fires', () => {
    expect(
      decideRelief(input({ usedTokens: 170_000, windowLaneEnabled: false })),
    ).toEqual({ kind: 'none' })
  })
})

describe('decideRelief — rss lane', () => {
  test('retained full results above the high water → clip to the low water', () => {
    const d = decideRelief(input({ retainedFullResultTokens: 260_000 }))
    expect(d).toEqual({
      kind: 'clip',
      lane: 'rss',
      tokensToFree: 135_000,
      trigger: 250_000,
      target: 125_000,
    })
  })

  test('survives the killswitch (memory bound, not cache policy)', () => {
    const d = decideRelief(
      input({ retainedFullResultTokens: 260_000, windowLaneEnabled: false }),
    )
    expect(d).toMatchObject({ lane: 'rss' })
  })

  test('aggressive (Infinity high water) never fires the rss lane', () => {
    expect(
      decideRelief(input({ retainedFullResultTokens: 1_000_000, profile: aggressive })),
    ).toEqual({ kind: 'none' })
  })

  test('both lanes fired: one event, sized by whichever asks for more', () => {
    // window asks 45.5k, rss asks 135k
    const both = decideRelief(input({ usedTokens: 140_000, retainedFullResultTokens: 260_000 }))
    expect(both).toMatchObject({ lane: 'rss', tokensToFree: 135_000 })
    // window asks 45.5k, rss asks 11k
    const windowWins = decideRelief(
      input({
        usedTokens: 140_000,
        retainedFullResultTokens: 101_000,
        profile: { ...retain, retainedHighWaterTokens: 100_000, retainedLowWaterTokens: 90_000 },
      }),
    )
    expect(windowWins).toMatchObject({ lane: 'window', tokensToFree: 45_500 })
  })
})

describe('selectReliefIds', () => {
  const cands = [
    { toolUseId: 'a', savings: 10 },
    { toolUseId: 'b', savings: 0 },
    { toolUseId: 'c', savings: 25 },
    { toolUseId: 'd', savings: 40 },
  ]

  test('oldest first, stops once the request is covered', () => {
    expect(selectReliefIds(cands, 30)).toEqual({ ids: ['a', 'c'], savings: 35 })
  })

  test('skips candidates that free nothing', () => {
    expect(selectReliefIds(cands, 12)).toEqual({ ids: ['a', 'c'], savings: 35 })
  })

  test('takes everything when the request exceeds what is available', () => {
    expect(selectReliefIds(cands, 1_000)).toEqual({ ids: ['a', 'c', 'd'], savings: 75 })
  })

  test('nothing to free → empty', () => {
    expect(selectReliefIds([], 10)).toEqual({ ids: [], savings: 0 })
    expect(selectReliefIds(cands, 0)).toEqual({ ids: [], savings: 0 })
  })
})

describe('isReliefWindowLaneEnabled', () => {
  const saved = process.env.CLAUDIN_DISABLE_RELIEF_POLICY
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDIN_DISABLE_RELIEF_POLICY
    else process.env.CLAUDIN_DISABLE_RELIEF_POLICY = saved
  })

  test('on by default, off under =1 / =true', () => {
    delete process.env.CLAUDIN_DISABLE_RELIEF_POLICY
    expect(isReliefWindowLaneEnabled()).toBe(true)
    process.env.CLAUDIN_DISABLE_RELIEF_POLICY = '1'
    expect(isReliefWindowLaneEnabled()).toBe(false)
    process.env.CLAUDIN_DISABLE_RELIEF_POLICY = 'true'
    expect(isReliefWindowLaneEnabled()).toBe(false)
    process.env.CLAUDIN_DISABLE_RELIEF_POLICY = '0'
    expect(isReliefWindowLaneEnabled()).toBe(true)
  })
})
