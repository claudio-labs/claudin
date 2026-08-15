import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { getProjectTotals, resetCostState } from 'src/agent/cost-tracker.js'
import { switchSession, getSessionId } from 'src/platform/bootstrap/state.js'
import { asSessionId } from 'src/shared/types/ids.js'
import { saveCurrentProjectConfig } from 'src/platform/config/config.js'

describe('getProjectTotals', () => {
  let nowSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    // Freeze the clock before resetCostState() captures STATE.startTime, so
    // getTotalDuration() (Date.now() - startTime) is a deterministic 0.
    // Otherwise the live wall-clock elapsed during the test (~1-2ms on CI)
    // leaks into totalDuration and flakes the exact `toBe(26_000)` assertion.
    nowSpy = spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    resetCostState()
    saveCurrentProjectConfig(current => ({
      ...current,
      cumulativeCost: 0,
      cumulativeAPIDuration: 0,
      cumulativeDuration: 0,
      cumulativeLinesAdded: 0,
      cumulativeLinesRemoved: 0,
      cumulativeModelUsage: {},
      lastCost: 0,
      lastAPIDuration: 0,
      lastDuration: 0,
      lastLinesAdded: 0,
      lastLinesRemoved: 0,
      lastModelUsage: undefined,
      lastSessionId: undefined,
    }))
  })

  afterEach(() => {
    nowSpy.mockRestore()
  })

  test('returns zeros when project config is empty and no in-memory state', () => {
    const totals = getProjectTotals()
    expect(totals.totalCost).toBe(0)
    expect(totals.modelUsage).toEqual({})
  })

  test('folds `last*` from a different session into totals on read', () => {
    // Simulate state on disk from a previous session that exited but never
    // got its last* folded into cumulative*.
    saveCurrentProjectConfig(current => ({
      ...current,
      cumulativeCost: 0.5,
      cumulativeAPIDuration: 10_000,
      cumulativeDuration: 20_000,
      cumulativeLinesAdded: 1,
      cumulativeLinesRemoved: 2,
      cumulativeModelUsage: {
        'claude-opus-4-7': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.5,
        },
      },
      lastCost: 0.25,
      lastAPIDuration: 5000,
      lastDuration: 6000,
      lastLinesAdded: 3,
      lastLinesRemoved: 4,
      lastModelUsage: {
        'claude-opus-4-7': {
          inputTokens: 20,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.25,
        },
      },
      lastSessionId: 'previous-session',
    }))

    switchSession(asSessionId('current-session'), null)
    expect(getSessionId()).toBe(asSessionId('current-session'))

    const totals = getProjectTotals()
    expect(totals.totalCost).toBeCloseTo(0.75, 5)
    expect(totals.totalAPIDuration).toBe(15_000)
    expect(totals.totalDuration).toBe(26_000)
    expect(totals.totalLinesAdded).toBe(4)
    expect(totals.totalLinesRemoved).toBe(6)
    expect(totals.modelUsage['claude-opus-4-7']).toEqual({
      inputTokens: 120,
      outputTokens: 60,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.75,
    })
  })

  test('does NOT double-count `last*` when it belongs to the current session', () => {
    switchSession(asSessionId('session-A'), null)
    saveCurrentProjectConfig(current => ({
      ...current,
      cumulativeCost: 0.5,
      lastCost: 0.25,
      lastSessionId: 'session-A',
      lastModelUsage: {
        'claude-opus-4-7': {
          inputTokens: 20,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.25,
        },
      },
    }))

    const totals = getProjectTotals()
    expect(totals.totalCost).toBeCloseTo(0.5, 5)
    expect(totals.modelUsage).toEqual({})
  })
})
