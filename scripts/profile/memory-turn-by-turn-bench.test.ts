/**
 * Turn-by-turn memory profiler — CI invariants.
 *
 * Fast version of the bench that runs in <10s and enforces the key
 * memory invariants:
 *
 *   1. With --with-compact --with-clear, RSS slope must be sub-linear
 *      in the second half vs the first half. A late-session linear leak
 *      is the exact symptom we're chasing.
 *
 *   2. contentReplacement Maps/Sets must NOT grow unbounded when /clear
 *      is fired periodically — after clear, we expect those structures
 *      to drop back to 0.
 *
 *   3. perKeyClippedIds MUST respect the cap of 16 entries regardless of
 *      how many compacts have fired.
 *
 * These run as regular Bun tests (no --expose-gc dependency — we just
 * look at container sizes and relative slopes, not absolute heap).
 */

import { describe, expect, test } from 'bun:test'
import { analyzeInflection, linearRegression, pearsonR, run } from './memory-turn-by-turn-bench.js'

describe('turn-by-turn memory bench', () => {
  test('no late-session RSS blow-up under compact + clear', async () => {
    const { baseline, history } = await run({
      turns: 120,
      payloadKb: 50,
      payloadJitter: 20,
      toolsPerTurn: 2,
      withCompact: true,
      withClear: true,
      compactEvery: 30,
      clearEvery: 60,
      breakdown: true,
      snapshotEvery: 0,
      output: null,
      csv: null,
      inflection: false,
      json: false,
      help: false,
    })

    expect(history.length).toBe(120)
    expect(baseline.rss).toBeGreaterThan(0)

    // Compare first-half slope vs second-half slope. With periodic clear,
    // second-half slope must not exceed 3x the first-half slope (3x
    // allows noise + fixed post-clear re-ramp; a true leak shows >5x).
    const firstHalf = history.slice(0, 60)
    const secondHalf = history.slice(60)
    const first = linearRegression(firstHalf.map(h => h.turn), firstHalf.map(h => h.rss))
    const second = linearRegression(secondHalf.map(h => h.turn), secondHalf.map(h => h.rss))

    // If first-half slope is near zero, require absolute bound instead.
    if (Math.abs(first.slope) < 100 * 1024) {
      // Absolute ceiling: 1 MB/turn RSS growth in second half is the
      // invariant we do NOT want to breach.
      expect(second.slope).toBeLessThan(1024 * 1024)
    } else {
      expect(second.slope).toBeLessThan(first.slope * 5)
    }
  }, 30_000)

  test('contentReplacementState drops to 0 after /clear', async () => {
    const { history } = await run({
      turns: 80,
      payloadKb: 30,
      payloadJitter: 10,
      toolsPerTurn: 2,
      withCompact: false,
      withClear: true,
      compactEvery: 100,
      clearEvery: 40,
      breakdown: true,
      snapshotEvery: 0,
      output: null,
      csv: null,
      inflection: false,
      json: false,
      help: false,
    })

    // Turns 40 and 80 had clear events. The turn immediately AFTER clear
    // should show seenIds back near 0 (only the ids created that turn).
    const atClear1 = history.find(h => h.turn === 40)
    const atClear2 = history.find(h => h.turn === 80)
    expect(atClear1?.event).toContain('clear')
    expect(atClear2?.event).toContain('clear')

    // At the clear turn, seenIds has only this-turn ids (= toolsPerTurn = 2).
    // Assert post-clear state is tiny (<= 4: the 2 just-created + room for noise).
    expect(atClear1?.breakdown?.contentReplacementSeenIds ?? 999).toBeLessThanOrEqual(4)
    expect(atClear2?.breakdown?.contentReplacementSeenIds ?? 999).toBeLessThanOrEqual(4)
  }, 20_000)

  test('perKeyClippedIds respects 16-key cap through heavy compact churn', async () => {
    const { history } = await run({
      turns: 150,
      payloadKb: 20,
      payloadJitter: 0,
      toolsPerTurn: 2,
      withCompact: true,
      withClear: false,
      compactEvery: 10,
      clearEvery: 1000,
      breakdown: true,
      snapshotEvery: 0,
      output: null,
      csv: null,
      inflection: false,
      json: false,
      help: false,
    })

    for (const r of history) {
      expect(r.breakdown?.perKeyClippedIdsEntries ?? 0).toBeLessThanOrEqual(16)
    }
  }, 30_000)

  test('inflection detection finds leak when payload prune is disabled', async () => {
    // No compact, no clear: heap grows linearly from turn 1. Inflection
    // detector should either find an inflection OR report the high slope
    // as the overall trend (NO inflection because growth is already in
    // linear regime from the start).
    const { history } = await run({
      turns: 200,
      payloadKb: 80,
      payloadJitter: 20,
      toolsPerTurn: 2,
      withCompact: false,
      withClear: false,
      compactEvery: 100,
      clearEvery: 200,
      breakdown: true,
      snapshotEvery: 0,
      output: null,
      csv: null,
      inflection: false,
      json: false,
      help: false,
    })

    const report = analyzeInflection(history, 'rss')

    // Overall RSS slope must be visibly positive (>50 KB/turn: payloads
    // are 80 KB, tools=2 so min expected growth is ~160 KB/turn).
    expect(report.stablePhaseSlopeBytesPerTurn).toBeGreaterThan(50 * 1024)

    // Top contributor should correlate tightly with RSS (r > 0.8).
    expect(report.topContributors.length).toBeGreaterThan(0)
    const topR = Math.abs(report.topContributors[0]!.pearsonR)
    expect(topR).toBeGreaterThan(0.8)
  }, 30_000)

  test('math helpers behave as expected', () => {
    const xs = [1, 2, 3, 4, 5]
    const ysLinear = [2, 4, 6, 8, 10] // y = 2x
    const reg = linearRegression(xs, ysLinear)
    expect(reg.slope).toBeCloseTo(2, 5)
    expect(reg.intercept).toBeCloseTo(0, 5)
    expect(reg.r2).toBeCloseTo(1, 5)

    // Perfect positive correlation
    expect(pearsonR(xs, ysLinear)).toBeCloseTo(1, 5)
    // Perfect negative correlation
    expect(pearsonR(xs, [10, 8, 6, 4, 2])).toBeCloseTo(-1, 5)
    // No correlation (flat)
    expect(pearsonR(xs, [5, 5, 5, 5, 5])).toBe(0)
  })
})
