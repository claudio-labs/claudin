import { describe, expect, test } from 'bun:test'

import { medianMs, replayArm, simulateCache, syntheticThread } from './classifier-cache-replay.ts'

const block = (name: string) => name.padEnd(400, '.')
const blocks = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => block(`b${from + i}`))
const MIN = 60_000

describe('simulateCache', () => {
  test('an append-only request reads the previous prefix and writes only the new blocks', () => {
    const totals = simulateCache([
      { blocks: blocks(0, 10), atMs: 0 },
      { blocks: blocks(0, 12), atMs: MIN },
    ])

    expect(totals.writes).toBe((10 * 400 + 2 * 400) / 4)
    expect(totals.reads).toBe((10 * 400) / 4)
    expect(totals.fullMisses).toBe(0)
  })

  test('dropping a block at the front rewrites the whole request', () => {
    const totals = simulateCache([
      { blocks: blocks(0, 10), atMs: 0 },
      { blocks: blocks(1, 11), atMs: MIN },
    ])

    expect(totals.reads).toBe(0)
    expect(totals.writes).toBe((20 * 400) / 4)
    expect(totals.fullMisses).toBe(1)
  })

  test('more than 20 new blocks puts the previous breakpoint out of the lookback', () => {
    const near = simulateCache([
      { blocks: blocks(0, 5), atMs: 0 },
      { blocks: blocks(0, 25), atMs: MIN },
    ])
    const far = simulateCache([
      { blocks: blocks(0, 5), atMs: 0 },
      { blocks: blocks(0, 26), atMs: MIN },
    ])

    expect(near.reads).toBe((5 * 400) / 4)
    expect(far.reads).toBe(0)
    expect(far.fullMisses).toBe(1)
  })

  test('an entry unused for over an hour has expired; a hit refreshes it', () => {
    const expired = simulateCache([
      { blocks: blocks(0, 4), atMs: 0 },
      { blocks: blocks(0, 4), atMs: 61 * MIN },
    ])
    const refreshed = simulateCache([
      { blocks: blocks(0, 4), atMs: 0 },
      { blocks: blocks(0, 4), atMs: 50 * MIN },
      { blocks: blocks(0, 4), atMs: 100 * MIN },
    ])

    expect(expired.reads).toBe(0)
    expect(refreshed.reads).toBe(2 * (4 * 400) / 4)
    expect(refreshed.writes).toBe((4 * 400) / 4)
  })

  test('a second breakpoint on the previous prefix brings a far request back into reach', () => {
    const far = [
      { blocks: blocks(0, 5), atMs: 0 },
      { blocks: blocks(0, 26), atMs: MIN },
    ]
    const marked = simulateCache([far[0]!, { ...far[1]!, lagBlocks: 5 }])

    expect(simulateCache(far).reads).toBe(0)
    expect(marked.reads).toBe((5 * 400) / 4)
    expect(marked.writes).toBe((5 * 400 + 21 * 400) / 4)
    expect(marked.fullMisses).toBe(0)
  })

  test('a marker on a prefix nothing wrote finds nothing, and costs nothing more', () => {
    const unmarked = simulateCache([
      { blocks: blocks(0, 5), atMs: 0 },
      { blocks: blocks(1, 30), atMs: MIN },
    ])
    const marked = simulateCache([
      { blocks: blocks(0, 5), atMs: 0 },
      { blocks: blocks(1, 30), atMs: MIN, lagBlocks: 4 },
    ])

    expect(marked.writes).toBe(unmarked.writes)
    expect(marked.reads).toBe(0)
  })

  test('a full miss is filed under why the prefix was not found', () => {
    const lookback = simulateCache([
      { blocks: blocks(0, 5), atMs: 0 },
      { blocks: blocks(0, 26), atMs: MIN },
    ])
    const front = simulateCache([
      { blocks: blocks(0, 10), atMs: 0 },
      { blocks: blocks(1, 11), atMs: MIN },
    ])
    const idle = simulateCache([
      { blocks: blocks(0, 4), atMs: 0 },
      { blocks: blocks(0, 4), atMs: 61 * MIN },
    ])

    expect(lookback.misses).toEqual({ lookback: 1, front: 0, idle: 0 })
    expect(lookback.written.lookback).toBe((26 * 400) / 4)
    expect(front.misses).toEqual({ lookback: 0, front: 1, idle: 0 })
    expect(idle.misses).toEqual({ lookback: 0, front: 0, idle: 1 })
    expect(idle.written.idle).toBe((4 * 400) / 4)
  })
})

describe('syntheticThread', () => {
  test('each step judges one call with every earlier one as its history', () => {
    const thread = syntheticThread(4, 100)

    expect(thread.decisions.map(d => d.history.length)).toEqual([0, 1, 2, 3])
    expect(thread.decisions[3]!.history[2]).toBe(thread.decisions[2]!.action)
    expect([...thread.toolNames]).toEqual(['Bash'])
  })
})

describe('medianMs', () => {
  test('the middle of the runs, so one slow call does not decide', () => {
    // Five calls taking 2, 2, 40, 3 and 2 ms on a clock the test drives.
    const durations = [2, 2, 40, 3, 2]
    let clock = 0
    let call = 0
    const ms = medianMs(
      () => {
        clock += durations[call++]!
      },
      5,
      () => clock,
    )
    expect(ms).toBe(2)
    expect(call).toBe(5)
  })
})

describe('replayArm', () => {
  test('keeps the decision with the longest kept transcript, and can build it again', () => {
    const thread = syntheticThread(6, 1_000)
    const tools = [{ name: 'Bash', aliases: [], toAutoClassifierInput: (input: unknown) => input }] as never
    const arm = replayArm(thread, tools, { stableCut: true, lag: true })

    expect(arm.largest?.keptChars).toBe(Math.max(...arm.keptChars))
    expect(arm.largest?.keptChars).toBe(arm.keptChars.at(-1)!)
    expect(() => arm.largest!.rerun()).not.toThrow()
  })
})
