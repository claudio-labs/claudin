/**
 * The memory features this fork runs ON where upstream shipped them off,
 * pinned at the functions callers read, plus the `CLAUDIN_*` env that turns
 * each one off or retunes it (see the gate-removal ledger under docs/tech/). Each
 * default goes red in scripts/migrations/probes/forkDefaults.json when it is
 * flipped.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { buildSearchingPastContextSection } from 'src/memory/memdir/memdir.js'
import {
  getExtractionTurnInterval,
  isExtractModeActive,
} from 'src/memory/memdir/paths.js'
import {
  getIsInteractive,
  setIsInteractive,
} from 'src/platform/bootstrap/state.js'

const ENV = [
  'CLAUDIN_EXTRACT_MEMORIES',
  'CLAUDIN_EXTRACT_MEMORIES_EVERY',
  'CLAUDIN_MEMORY_PAST_CONTEXT',
] as const
const saved = new Map(ENV.map(name => [name, process.env[name]]))
const wasInteractive = getIsInteractive()

beforeEach(() => {
  for (const name of ENV) delete process.env[name]
})

afterEach(() => {
  setIsInteractive(wasInteractive)
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
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

  test('CLAUDIN_EXTRACT_MEMORIES=0 turns it off', () => {
    setIsInteractive(true)
    process.env.CLAUDIN_EXTRACT_MEMORIES = '0'
    expect(isExtractModeActive()).toBe(false)
  })

  test('fires every 15 eligible turns', () => {
    expect(getExtractionTurnInterval()).toBe(15)
  })

  test('CLAUDIN_EXTRACT_MEMORIES_EVERY retunes the cadence', () => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '3'
    expect(getExtractionTurnInterval()).toBe(3)
  })

  test.each(['0', '-2', 'soon'])(
    'CLAUDIN_EXTRACT_MEMORIES_EVERY=%s keeps the default',
    value => {
      process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = value
      expect(getExtractionTurnInterval()).toBe(15)
    },
  )
})

describe('the memory prompt', () => {
  test('teaches how to search past context', () => {
    expect(buildSearchingPastContextSection('/mem').join('\n')).toContain(
      'Searching past context',
    )
  })

  test('CLAUDIN_MEMORY_PAST_CONTEXT=0 drops the section', () => {
    process.env.CLAUDIN_MEMORY_PAST_CONTEXT = '0'
    expect(buildSearchingPastContextSection('/mem')).toEqual([])
  })
})
