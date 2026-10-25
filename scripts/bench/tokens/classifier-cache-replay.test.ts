import { describe, expect, test } from 'bun:test'

import { simulateCache } from './classifier-cache-replay.ts'

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
})
