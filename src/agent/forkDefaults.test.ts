/**
 * Features this fork runs ON where upstream shipped them off, pinned at the
 * surface that callers read, plus the `CLAUDIN_*=0` killswitch that turns each
 * one off (see the gate-removal ledger under docs/tech/). Each default goes red in
 * scripts/migrations/probes/forkDefaults.json when it is flipped.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { isAwaySummaryEnabled } from 'src/agent/awaySummary.js'
import { isScratchpadEnabled } from 'src/agent/scratchpad.js'
import { isDeferredToolsDeltaEnabled } from 'src/agent/tools/toolSearch.js'
import { clearBetaHeaderLatches } from 'src/platform/bootstrap/state.js'
import { getPrompt } from 'src/tools/ToolSearchTool/prompt.js'

const KILLSWITCHES = [
  'CLAUDIN_SCRATCHPAD',
  'CLAUDIN_AWAY_SUMMARY',
  'CLAUDIN_DEFERRED_TOOLS_DELTA',
] as const
const saved = new Map(KILLSWITCHES.map(name => [name, process.env[name]]))

beforeEach(() => {
  for (const name of KILLSWITCHES) delete process.env[name]
  // The legacy-announcement latch flips the ToolSearch hint independently of
  // the default; start every test from a fresh session.
  clearBetaHeaderLatches()
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('on by default in this fork', () => {
  test('the scratchpad is enabled', () => {
    expect(isScratchpadEnabled()).toBe(true)
  })

  test('the away summary is enabled', () => {
    expect(isAwaySummaryEnabled()).toBe(true)
  })

  test('deferred tools are announced by delta attachment', () => {
    expect(isDeferredToolsDeltaEnabled()).toBe(true)
  })

  test('the ToolSearch description points at the delta attachments', () => {
    // prompt.ts reads the default on its own path (toolSearch.ts imports it,
    // so it cannot import back); the two must agree or the tools array
    // diverges from what the attachments announce.
    expect(getPrompt()).toContain(
      'Deferred tools appear by name in <system-reminder> messages.',
    )
  })
})

describe('=0 turns each one off', () => {
  test('CLAUDIN_SCRATCHPAD=0', () => {
    process.env.CLAUDIN_SCRATCHPAD = '0'
    expect(isScratchpadEnabled()).toBe(false)
  })

  test('CLAUDIN_AWAY_SUMMARY=0', () => {
    process.env.CLAUDIN_AWAY_SUMMARY = '0'
    expect(isAwaySummaryEnabled()).toBe(false)
  })

  test('CLAUDIN_DEFERRED_TOOLS_DELTA=0 flips the announcement and the hint together', () => {
    process.env.CLAUDIN_DEFERRED_TOOLS_DELTA = '0'
    expect(isDeferredToolsDeltaEnabled()).toBe(false)
    expect(getPrompt()).toContain(
      'Deferred tools appear by name in <available-deferred-tools> messages.',
    )
  })
})
