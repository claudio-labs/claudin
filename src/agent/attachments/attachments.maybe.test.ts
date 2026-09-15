import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { maybe } from 'src/agent/attachments/attachments.js'

describe('maybe wrapper', () => {
  const originalRandom = Math.random

  beforeEach(() => {
    Math.random = () => 0
  })

  afterEach(() => {
    Math.random = originalRandom
  })

  test('returns producer result on success', async () => {
    const result = await maybe('happy', async () => [{ a: 1 }, { a: 2 }])
    expect(result).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('swallows producer errors and returns []', async () => {
    const result = await maybe('boom', async () => {
      throw new Error('producer exploded')
    })
    expect(result).toEqual([])
  })

  // Four tests lived here that asserted only on the sampled duration event —
  // its label, its counts, and that sampling suppressed it. The event reached a
  // function the build stubs to an empty body, so with it gone they had nothing
  // left to observe. The one behavioural claim among them survives below:
  // `maybe` passes holes through rather than compacting the array.
  test('passes undefined and null entries through without compacting', async () => {
    const result = await maybe('with-holes', async () =>
      [{ a: 1 }, undefined, null, { a: 2 }] as unknown as Array<{ a: number }>,
    )
    expect(result).toHaveLength(4)
  })
})
