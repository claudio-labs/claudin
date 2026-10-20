/**
 * Spend by source: what each querySource cost, kept beside the per-model
 * totals and carried by the `cost-state` entry.
 *
 * The 2026-10-16..19 census could not see the auto-mode classifier at all:
 * `sideQuery()` never reached the cost tracker, so its Opus calls were missing
 * from `/cost` and from the exit `cost-state`, and the 6.6% the transcripts
 * could not account for had no name. These pin that every spend is counted
 * under its source and survives a resume.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  addSideQueryCost,
  addToTotalSessionCost,
  getCostStateEntryFor,
  getModelUsage,
  getSourceUsage,
  getTotalCost,
  resetCostState,
  restoreCostStateForResume,
} from 'src/agent/cost-tracker.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { getSessionCacheMetrics } from 'src/providers/cache/cacheStatsTracker.js'

type Usage = Parameters<typeof addToTotalSessionCost>[1]

function usage(input: number, output: number, cacheRead = 0, cacheCreation = 0): Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  } as Usage
}

const NO_CONFIG = { restoreFromProjectConfig: () => false }

beforeEach(() => {
  resetCostState()
})

describe('spend by source', () => {
  test('each source keeps its own calls, tokens and cost', () => {
    addToTotalSessionCost(0.5, usage(10, 20, 1_000, 100), 'claude-opus-5-5', 'repl_main_thread')
    addToTotalSessionCost(0.25, usage(1, 2, 300), 'claude-opus-5-5', 'repl_main_thread')
    addToTotalSessionCost(0.1, usage(5, 5), 'claude-haiku-5-5', 'away_summary')
    const bySource = getSourceUsage()
    expect(bySource.repl_main_thread).toEqual({
      calls: 2,
      costUSD: 0.75,
      inputTokens: 11,
      outputTokens: 22,
      cacheReadInputTokens: 1_300,
      cacheCreationInputTokens: 100,
    })
    expect(bySource.away_summary?.calls).toBe(1)
    expect(bySource.away_summary?.costUSD).toBeCloseTo(0.1)
  })

  test('a spend with no source is counted as unattributed, never dropped', () => {
    addToTotalSessionCost(0.3, usage(1, 1), 'claude-opus-5-5')
    expect(getSourceUsage().unattributed?.costUSD).toBeCloseTo(0.3)
  })

  test('a side query adds to the session cost and the model usage, not to the cache stats', () => {
    addSideQueryCost(0.2, usage(100, 10, 5_000), 'claude-opus-5-5', 'auto_mode')
    expect(getTotalCost()).toBeCloseTo(0.2)
    expect(getModelUsage()['claude-opus-5-5']?.cacheReadInputTokens).toBe(5_000)
    expect(getSourceUsage().auto_mode).toMatchObject({ calls: 1, cacheReadInputTokens: 5_000 })
    // The hit rate and the `[Cache:]` line describe the conversation's own
    // prefix; a classifier's prompt is not part of it.
    expect(getSessionCacheMetrics().total).toBe(0)
  })

  test('the cost-state entry carries it, a reset clears it and a resume restores it', () => {
    addSideQueryCost(0.2, usage(100, 10), 'claude-opus-5-5', 'auto_mode')
    const sessionId = getSessionId()
    const entry = getCostStateEntryFor(sessionId)
    expect(entry?.sourceUsage?.auto_mode?.calls).toBe(1)

    resetCostState()
    expect(getSourceUsage()).toEqual({})

    restoreCostStateForResume(sessionId, { costState: entry!, messages: [] }, NO_CONFIG)
    expect(getSourceUsage().auto_mode?.costUSD).toBeCloseTo(0.2)
    // A restored map is a copy: spending after the resume does not write
    // into the entry it came from.
    addSideQueryCost(0.1, usage(1, 1), 'claude-opus-5-5', 'auto_mode')
    expect(entry?.sourceUsage?.auto_mode?.calls).toBe(1)
  })

  test('an entry written before sourceUsage existed restores to an empty map', () => {
    addToTotalSessionCost(0.4, usage(1, 1), 'claude-opus-5-5', 'repl_main_thread')
    const sessionId = getSessionId()
    const { sourceUsage: _dropped, ...older } = getCostStateEntryFor(sessionId)!
    resetCostState()
    addToTotalSessionCost(0.1, usage(1, 1), 'claude-opus-5-5', 'repl_main_thread')
    restoreCostStateForResume(sessionId, { costState: older, messages: [] }, NO_CONFIG)
    expect(getTotalCost()).toBeCloseTo(0.4)
    expect(getSourceUsage()).toEqual({})
  })
})
