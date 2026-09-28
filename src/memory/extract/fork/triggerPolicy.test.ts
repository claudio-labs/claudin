/**
 * The trigger policy as a table: which end of turn forks, which does not, and
 * which of its signals each outcome had to read.
 */
import { describe, expect, test } from 'bun:test'

import {
  decideExtraction,
  gateOf,
  loopHasFired,
  NO_FIRED_LOOPS,
  withFiredLoop,
  type GateReadings,
  type TriggerInput,
} from 'src/memory/extract/fork/triggerPolicy.js'
import type { LoopSignal } from 'src/memory/extract/loopDetector.js'

const OPEN: GateReadings = { subAgentTurn: false, extractionEnabled: true, autoMemoryEnabled: true }

function loop(loopKey: string, userTurnUuid: string | undefined, repeatCount = 3): LoopSignal {
  return { toolName: 'Bash', repeatCount, loopKey, userTurnUuid }
}

/** A signal the decision must not need for the outcome under test. */
function mustNotRead(what: string): () => never {
  return () => {
    throw new Error(`${what} was read`)
  }
}

function turn(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    gates: OPEN,
    overlap: 'none',
    turnsCounted: 0,
    interval: 3,
    firedLoops: NO_FIRED_LOOPS,
    mainAgentSaved: () => false,
    repeatedErrorLoop: () => null,
    ...overrides,
  }
}

describe('gateOf', () => {
  test('three gates and no other: of the eight combinations only the all-open one passes, remote mode being none of them', () => {
    const passing: GateReadings[] = []
    for (const subAgentTurn of [false, true]) {
      for (const extractionEnabled of [false, true]) {
        for (const autoMemoryEnabled of [false, true]) {
          const readings = { subAgentTurn, extractionEnabled, autoMemoryEnabled }
          if (gateOf(readings) === undefined) passing.push(readings)
        }
      }
    }
    expect(passing).toEqual([OPEN])
  })

  test('names the sub-agent turn first, then the extraction switch, then auto memory', () => {
    expect(gateOf({ subAgentTurn: true, extractionEnabled: false, autoMemoryEnabled: false })).toBe('subAgentTurn')
    expect(gateOf({ subAgentTurn: false, extractionEnabled: false, autoMemoryEnabled: false })).toBe('extractionOff')
    expect(gateOf({ subAgentTurn: false, extractionEnabled: true, autoMemoryEnabled: false })).toBe('autoMemoryOff')
  })
})

describe('decideExtraction', () => {
  test('a closed gate decides before anything else is read, a running fork included', () => {
    const decision = decideExtraction(
      turn({
        gates: { ...OPEN, autoMemoryEnabled: false },
        overlap: 'forkRunning',
        mainAgentSaved: mustNotRead('the main-agent save'),
        repeatedErrorLoop: mustNotRead('the loop'),
      }),
    )
    expect(decision).toEqual({ kind: 'gated', gate: 'autoMemoryOff' })
  })

  test('a turn that ends during a fork is held, without reading its transcript', () => {
    const decision = decideExtraction(
      turn({
        overlap: 'forkRunning',
        mainAgentSaved: mustNotRead('the main-agent save'),
        repeatedErrorLoop: mustNotRead('the loop'),
      }),
    )
    expect(decision).toEqual({ kind: 'held' })
  })

  test("the main agent's own save wins over a following fork and over a loop", () => {
    expect(decideExtraction(turn({ overlap: 'trailing', mainAgentSaved: () => true }))).toEqual({
      kind: 'mainAgentSaved',
    })
    const withLoop = turn({ mainAgentSaved: () => true, repeatedErrorLoop: mustNotRead('the loop') })
    expect(decideExtraction(withLoop)).toEqual({ kind: 'mainAgentSaved' })
  })

  test('a held turn follows the fork whatever the cadence, and never as a loop fork', () => {
    const decision = decideExtraction(
      turn({ overlap: 'trailing', interval: 1_000, repeatedErrorLoop: mustNotRead('the loop') }),
    )
    expect(decision).toEqual({ kind: 'fork', reason: 'trailing' })
  })

  test('a loop not acted on yet forks at once, carrying the loop', () => {
    const found = loop('bash:build', 'turn-1')
    expect(decideExtraction(turn({ interval: 1_000, repeatedErrorLoop: () => found }))).toEqual({
      kind: 'fork',
      reason: 'loop',
      loop: found,
    })
  })

  test('a loop already acted on in this human turn leaves the turn to the cadence', () => {
    const found = loop('bash:build', 'turn-1')
    const firedLoops = withFiredLoop(NO_FIRED_LOOPS, found)
    expect(decideExtraction(turn({ firedLoops, repeatedErrorLoop: () => found }))).toEqual({
      kind: 'throttled',
      turnsCounted: 1,
    })
    expect(decideExtraction(turn({ firedLoops, turnsCounted: 2, repeatedErrorLoop: () => found }))).toEqual({
      kind: 'fork',
      reason: 'routine',
    })
  })

  test('the cadence counts turns up to the interval, and a count already past a lowered one forks', () => {
    expect(decideExtraction(turn({ turnsCounted: 0, interval: 3 }))).toEqual({ kind: 'throttled', turnsCounted: 1 })
    expect(decideExtraction(turn({ turnsCounted: 1, interval: 3 }))).toEqual({ kind: 'throttled', turnsCounted: 2 })
    expect(decideExtraction(turn({ turnsCounted: 2, interval: 3 }))).toEqual({ kind: 'fork', reason: 'routine' })
    expect(decideExtraction(turn({ turnsCounted: 7, interval: 2 }))).toEqual({ kind: 'fork', reason: 'routine' })
  })
})

describe('the loops acted on', () => {
  test('pile up within one human turn, and are forgotten when a new one starts', () => {
    const build = loop('bash:build', 'turn-1')
    const edit = loop('edit:app', 'turn-1', 4)
    const both = withFiredLoop(withFiredLoop(NO_FIRED_LOOPS, build), edit)
    expect(loopHasFired(both, build)).toBe(true)
    expect(loopHasFired(both, edit)).toBe(true)

    const nextTurn = loop('bash:build', 'turn-2')
    expect(loopHasFired(both, nextTurn)).toBe(false)
    const afterNext = withFiredLoop(both, nextTurn)
    expect(loopHasFired(afterNext, nextTurn)).toBe(true)
    expect(loopHasFired(afterNext, edit)).toBe(false)
  })

  test('none have fired at the start', () => {
    expect(loopHasFired(NO_FIRED_LOOPS, loop('bash:build', undefined))).toBe(false)
  })
})
