/**
 * `--max-budget-usd` on a resumed session. The resume puts the session's cost
 * back into the counters, so `total_cost_usd` reports the session (Claude
 * Code's `cost-state`, 2.1.280) — and Claude Code compares only what the
 * resumed process adds on top: each resumed run gets the whole budget, and
 * its `budget_usd` reminder reports that same figure as used. Compared with
 * the restored total, a `-p --resume` of a session that had already cost more
 * than the budget stopped after its first response.
 *
 * Both consumers read the live counters, so the fixture is a real restore
 * (restoreCostStateForResume) and real spend (addToTotalSessionCost).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'

import { getMaxBudgetUsdAttachment } from 'src/agent/attachments/injections.js'
import {
  addToTotalSessionCost,
  getTotalCost,
  resetCostState,
  resetCostStateOwnerForTesting,
  restoreCostStateForResume,
} from 'src/agent/cost-tracker.js'
import { isMaxBudgetReached } from 'src/agent/QueryEngine.js'
import type { CostStateEntry } from 'src/shared/types/logs.js'

const MODEL = 'claude-sonnet-4-5-20250514'
const NO_PROJECT_CONFIG = { restoreFromProjectConfig: () => false }

/** What an earlier process stamped for `sid`. */
function stamped(sid: UUID, totalCostUSD: number): CostStateEntry {
  return {
    type: 'cost-state',
    sessionId: sid,
    totalCostUSD,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalDuration: 0,
    startTime: Date.parse('2026-09-23T10:00:00.000Z'),
    modelUsage: {},
  }
}

/** `-p --resume` of a session whose transcript says it cost `totalCostUSD`. */
function resumeSessionThatCost(totalCostUSD: number): void {
  const sid = randomUUID()
  restoreCostStateForResume(
    sid,
    { costState: stamped(sid, totalCostUSD), messages: [] },
    NO_PROJECT_CONFIG,
  )
}

/** One response of the resumed process, billed at `cost`. */
function spend(cost: number): void {
  addToTotalSessionCost(
    cost,
    {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as Parameters<typeof addToTotalSessionCost>[1],
    MODEL,
  )
}

beforeEach(() => {
  resetCostState()
})

afterAll(() => {
  resetCostState()
  resetCostStateOwnerForTesting()
})

describe('--max-budget-usd on a resumed session', () => {
  test('the cost it carried in does not count: the run goes on until its own spend reaches the budget', () => {
    resumeSessionThatCost(2.5)

    expect(isMaxBudgetReached(1)).toBe(false)
    spend(0.5)
    expect(isMaxBudgetReached(1)).toBe(false)
    spend(0.5)
    expect(isMaxBudgetReached(1)).toBe(true)
    // total_cost_usd still reports the whole session.
    expect(getTotalCost()).toBe(3.5)
  })

  test('the budget_usd reminder reports what this run spent', () => {
    resumeSessionThatCost(2.5)
    spend(0.25)

    expect(getMaxBudgetUsdAttachment(1)).toEqual([
      { type: 'budget_usd', used: 0.25, total: 1, remaining: 0.75 },
    ])
  })
})
