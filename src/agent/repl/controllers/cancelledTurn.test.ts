import { describe, expect, test } from 'bun:test'

import {
  CANCELLED_TURN_SETTLE_MS,
  createCancelledTurns,
} from 'src/agent/repl/controllers/cancelledTurn.js'

// Generations as QueryGuard counts them: tryStart and forceEnd each add one, so
// a turn cancelled at generation 1 is followed by a turn at generation 3.
// 660bb320 (2026-11-09) is the case: the aborted WaitFor answered ~1.1 s after
// the queued prompt's turn had started.

describe('createCancelledTurns', () => {
  test('a turn with nothing older in flight does not wait', async () => {
    const turns = createCancelledTurns()
    expect(await turns.settle(1)).toBe('idle')
    turns.begin(1)
    turns.end(1)
    turns.begin(3)
    expect(await turns.settle(3)).toBe('idle')
  })

  test('660bb320 11-09: the next turn waits until the cancelled one has drained', async () => {
    const turns = createCancelledTurns()
    turns.begin(1)
    turns.begin(3)
    let drained = false
    setTimeout(() => {
      drained = true
      turns.end(1)
    }, 20)
    expect(await turns.settle(3, 1_000)).toBe('settled')
    expect(drained).toBe(true)
    expect(turns.isAbandoned(1)).toBe(false)
  })

  test('a turn never waits for itself or a newer one', async () => {
    const turns = createCancelledTurns()
    turns.begin(3)
    turns.begin(5)
    expect(await turns.settle(3, 10)).toBe('idle')
  })

  test('a turn slower than the bound is abandoned, and only that one', async () => {
    const turns = createCancelledTurns()
    turns.begin(1)
    turns.begin(3)
    turns.end(3)
    turns.begin(5)
    expect(await turns.settle(5, 10)).toBe('timedOut')
    expect(turns.isAbandoned(1)).toBe(true)
    expect(turns.isAbandoned(3)).toBe(false)
    expect(turns.isAbandoned(5)).toBe(false)
    // It still drains later; ending it closes the books on it.
    turns.end(1)
    expect(turns.isAbandoned(1)).toBe(false)
    turns.end(5)
    expect(await turns.settle(7, 10)).toBe('idle')
  })

  test('begin and end are idempotent, and an unknown generation is a no-op', async () => {
    const turns = createCancelledTurns()
    turns.end(9)
    turns.begin(1)
    turns.begin(1)
    turns.end(1)
    turns.end(1)
    expect(await turns.settle(3, 10)).toBe('idle')
  })

  test('the default bound is five seconds', () => {
    expect(CANCELLED_TURN_SETTLE_MS).toBe(5_000)
  })
})
