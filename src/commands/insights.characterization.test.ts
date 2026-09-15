/**
 * Characterization suite for `src/commands/insights.ts`, written BEFORE the
 * barrel split and kept BYTE-IDENTICAL across every extraction commit.
 *
 * The file had no test at all — 2832 lines with a single importer, which is
 * exactly the shape where a relocation goes wrong quietly. That importer is
 * `src/commands/commands.ts:205`:
 *
 *     const real = (await import('src/commands/insights.js')).default
 *
 * a DYNAMIC import of the DEFAULT export. Neither tsc nor the build's import
 * pre-scan follows it into a barrel, so a barrel that re-exports the four
 * named symbols and forgets `default` breaks `/insights` at runtime and
 * nowhere earlier. The first two tests below are that gate.
 *
 * The rest pin the three pure functions the pipeline is built on. Everything
 * else in the module is private and stays private: this suite deliberately
 * adds no export, because widening the surface to test a relocation is the
 * change the relocation was supposed not to make.
 */
import { describe, expect, test } from 'bun:test'

import * as insightsModule from 'src/commands/insights.js'
import usageReport, {
  buildExportData,
  deduplicateSessionBranches,
  detectMultiClauding,
} from 'src/commands/insights.js'

const MINUTE = 60_000

/** `deduplicateSessionBranches` reads only two meta fields; the rest is noise. */
function branch(
  sessionId: string,
  userMessageCount: number,
  durationMinutes: number,
  tag: string,
): Parameters<typeof deduplicateSessionBranches>[0][number] {
  return {
    log: { tag } as unknown as Parameters<
      typeof deduplicateSessionBranches
    >[0][number]['log'],
    meta: {
      session_id: sessionId,
      user_message_count: userMessageCount,
      duration_minutes: durationMinutes,
    } as unknown as Parameters<
      typeof deduplicateSessionBranches
    >[0][number]['meta'],
  }
}

function tagOf(
  entry: Parameters<typeof deduplicateSessionBranches>[0][number],
): string {
  return (entry.log as unknown as { tag: string }).tag
}

// ───────────────────────────────────────────────────────────────────────────
// The barrel's gate. `default` is the one that matters and the one a
// hand-written re-export list forgets.
// ───────────────────────────────────────────────────────────────────────────

describe('the module export surface', () => {
  test('exports exactly these runtime symbols, default included', () => {
    expect(Object.keys(insightsModule).sort()).toEqual([
      'buildExportData',
      'deduplicateSessionBranches',
      'default',
      'detectMultiClauding',
      'generateUsageReport',
    ])
  })

  test('the default export is the /insights command commands.ts loads', () => {
    // commands.ts reaches this through a dynamic import of `.default` and
    // immediately reads `type` and `getPromptForCommand`.
    expect(usageReport.name).toBe('insights')
    expect(usageReport.type).toBe('prompt')
    expect((usageReport as { source?: unknown }).source).toBe('builtin')
    expect(typeof usageReport.description).toBe('string')
    expect(usageReport.description.length).toBeGreaterThan(0)
    expect(
      typeof (usageReport as { getPromptForCommand?: unknown })
        .getPromptForCommand,
    ).toBe('function')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Branch deduplication. A session file with retries yields one LogOption per
// leaf, all sharing a root, so their durations overlap — double-counting them
// is what this drops.
// ───────────────────────────────────────────────────────────────────────────

describe('deduplicateSessionBranches', () => {
  test('keeps the branch with the most user messages', () => {
    const kept = deduplicateSessionBranches([
      branch('s1', 2, 90, 'short'),
      branch('s1', 7, 10, 'long'),
    ])
    expect(kept).toHaveLength(1)
    expect(tagOf(kept[0]!)).toBe('long')
  })

  test('breaks a tie on user messages by the longer duration', () => {
    const kept = deduplicateSessionBranches([
      branch('s1', 5, 10, 'brief'),
      branch('s1', 5, 40, 'extended'),
    ])
    expect(kept).toHaveLength(1)
    expect(tagOf(kept[0]!)).toBe('extended')
  })

  test('keeps the first entry when both fields tie', () => {
    const kept = deduplicateSessionBranches([
      branch('s1', 5, 10, 'first'),
      branch('s1', 5, 10, 'second'),
    ])
    expect(tagOf(kept[0]!)).toBe('first')
  })

  test('never merges distinct sessions, and passes an empty list through', () => {
    expect(
      deduplicateSessionBranches([
        branch('s1', 1, 1, 'a'),
        branch('s2', 1, 1, 'b'),
      ]),
    ).toHaveLength(2)
    expect(deduplicateSessionBranches([])).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Multi-clauding detection: the s1 → s2 → s1 pattern inside a 30-minute
// sliding window.
// ───────────────────────────────────────────────────────────────────────────

describe('detectMultiClauding', () => {
  const at = (offsetMs: number): string =>
    new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString()

  test('a single session never overlaps with itself', () => {
    expect(
      detectMultiClauding([
        {
          session_id: 's1',
          user_message_timestamps: [at(0), at(5 * MINUTE), at(10 * MINUTE)],
        },
      ]),
    ).toEqual({
      overlap_events: 0,
      sessions_involved: 0,
      user_messages_during: 0,
    })
  })

  test('detects a return to an earlier session inside the window', () => {
    expect(
      detectMultiClauding([
        { session_id: 's1', user_message_timestamps: [at(0), at(20 * MINUTE)] },
        { session_id: 's2', user_message_timestamps: [at(10 * MINUTE)] },
      ]),
    ).toEqual({
      overlap_events: 1,
      sessions_involved: 2,
      user_messages_during: 3,
    })
  })

  test('the same interleaving spread past 30 minutes is not an overlap', () => {
    // Identical shape, only the spacing changes — this is the assertion that
    // makes the window load-bearing rather than incidental.
    expect(
      detectMultiClauding([
        { session_id: 's1', user_message_timestamps: [at(0), at(80 * MINUTE)] },
        { session_id: 's2', user_message_timestamps: [at(40 * MINUTE)] },
      ]).overlap_events,
    ).toBe(0)
  })

  test('sessions with no messages produce no events', () => {
    expect(
      detectMultiClauding([
        { session_id: 's1', user_message_timestamps: [] },
        { session_id: 's2', user_message_timestamps: [] },
      ]).overlap_events,
    ).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The export payload the background S3 upload sends.
// ───────────────────────────────────────────────────────────────────────────

describe('buildExportData', () => {
  type Facets = Parameters<typeof buildExportData>[2] extends Map<
    string,
    infer V
  >
    ? V
    : never

  function facet(overrides: Record<string, unknown>): Facets {
    return {
      goal_categories: {},
      outcome: 'success',
      user_satisfaction_counts: {},
      friction_counts: {},
      ...overrides,
    } as unknown as Facets
  }

  const data = {
    date_range: { start: '2026-01-01', end: '2026-01-31' },
    total_sessions: 12,
  } as unknown as Parameters<typeof buildExportData>[0]
  const insights = {} as unknown as Parameters<typeof buildExportData>[1]

  test('sums facet counters across sessions and counts each outcome once', () => {
    const exported = buildExportData(
      data,
      insights,
      new Map([
        ['a', facet({ goal_categories: { refactor: 2 }, outcome: 'success' })],
        ['b', facet({ goal_categories: { refactor: 3 }, outcome: 'failure' })],
      ]),
    )

    expect(exported.facets_summary?.total).toBe(2)
    expect(exported.facets_summary?.goal_categories).toEqual({ refactor: 5 })
    expect(exported.facets_summary?.outcomes).toEqual({
      success: 1,
      failure: 1,
    })
  })

  test('drops zero counts instead of emitting empty buckets', () => {
    const exported = buildExportData(
      data,
      insights,
      new Map([
        [
          'a',
          facet({
            goal_categories: { debug: 0 },
            friction_counts: { retries: 0, confusion: 4 },
            user_satisfaction_counts: { high: 0 },
          }),
        ],
      ]),
    )

    expect(exported.facets_summary?.goal_categories).toEqual({})
    expect(exported.facets_summary?.friction).toEqual({ confusion: 4 })
    expect(exported.facets_summary?.satisfaction).toEqual({})
  })

  test('carries the date range and session count into the metadata', () => {
    const exported = buildExportData(data, insights, new Map())

    expect(exported.metadata.date_range).toEqual({
      start: '2026-01-01',
      end: '2026-01-31',
    })
    expect(exported.metadata.session_count).toBe(12)
    expect(exported.aggregated_data).toBe(data)
    expect(exported.insights).toBe(insights)
  })
})
