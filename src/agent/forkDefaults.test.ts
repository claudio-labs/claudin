/**
 * Features this fork runs ON where upstream shipped them off, pinned at the
 * surface that callers read — not at the flag that decides them — so the pin
 * holds while the decision moves from a `tengu_*` gate to a `CLAUDIN_*` env
 * (docs/tech/tengu-census/gate-audit.md). Each line here goes red in
 * scripts/migrations/probes/forkDefaults.json when its default is flipped.
 */
import { beforeEach, describe, expect, test } from 'bun:test'

import { isAwaySummaryEnabled } from 'src/agent/awaySummary.js'
import { isScratchpadEnabled } from 'src/agent/scratchpad.js'
import { isDeferredToolsDeltaEnabled } from 'src/agent/tools/toolSearch.js'
import { clearBetaHeaderLatches } from 'src/platform/bootstrap/state.js'
import { getPrompt } from 'src/tools/ToolSearchTool/prompt.js'

beforeEach(() => {
  // The legacy-announcement latch flips the ToolSearch hint independently of
  // the default; start every test from a fresh session.
  clearBetaHeaderLatches()
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
    // prompt.ts reads the default on its own (toolSearch.ts imports it, so it
    // cannot import back); the two must agree or the tools array diverges from
    // what the attachments announce.
    expect(getPrompt()).toContain(
      'Deferred tools appear by name in <system-reminder> messages.',
    )
  })
})
