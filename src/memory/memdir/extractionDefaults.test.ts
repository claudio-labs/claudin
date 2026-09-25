/**
 * The memory features this fork runs ON where upstream shipped them off,
 * pinned at the functions callers read so the pin holds while the decision
 * moves from a `tengu_*` gate to a `CLAUDIN_*` env
 * (docs/tech/tengu-census/gate-audit.md). Each line here goes red in
 * scripts/migrations/probes/forkDefaults.json when its default is flipped.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { buildSearchingPastContextSection } from 'src/memory/memdir/memdir.js'
import {
  getExtractionTurnInterval,
  isExtractModeActive,
} from 'src/memory/memdir/paths.js'
import {
  getIsInteractive,
  setIsInteractive,
} from 'src/platform/bootstrap/state.js'

const wasInteractive = getIsInteractive()

afterEach(() => {
  setIsInteractive(wasInteractive)
})

describe('memory extraction', () => {
  test('runs in an interactive session', () => {
    setIsInteractive(true)
    expect(isExtractModeActive()).toBe(true)
  })

  test('does not run in a non-interactive one', () => {
    setIsInteractive(false)
    expect(isExtractModeActive()).toBe(false)
  })

  test('fires every 15 eligible turns', () => {
    expect(getExtractionTurnInterval()).toBe(15)
  })
})

describe('the memory prompt', () => {
  test('teaches how to search past context', () => {
    expect(buildSearchingPastContextSection('/mem').join('\n')).toContain(
      'Searching past context',
    )
  })
})
