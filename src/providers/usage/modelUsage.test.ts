import { describe, expect, test } from 'bun:test'

import {
  addModelUsage,
  addModelUsageTo,
  emptyModelUsage,
  remainingModelUsage,
} from 'src/providers/usage/modelUsage.js'
import type { CostStateModelUsage } from 'src/shared/types/logs.js'

const FULL: CostStateModelUsage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 4,
  webSearchRequests: 5,
  costUSD: 0.5,
}

describe('modelUsage', () => {
  test('addModelUsage adds every field into the target and returns it', () => {
    const acc = emptyModelUsage()
    expect(addModelUsage(addModelUsage(acc, FULL), FULL)).toBe(acc)
    expect(acc).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadInputTokens: 6,
      cacheCreationInputTokens: 8,
      webSearchRequests: 10,
      costUSD: 1,
    })
  })

  test('addModelUsageTo creates the entry without aliasing the source', () => {
    const map: Record<string, CostStateModelUsage> = {}
    addModelUsageTo(map, 'm', FULL)
    addModelUsageTo(map, 'm', FULL)
    expect(map.m?.webSearchRequests).toBe(10)
    expect(FULL.webSearchRequests).toBe(5)
  })

  test('remainingModelUsage clamps each field at zero', () => {
    const rest = remainingModelUsage(FULL, { ...FULL, inputTokens: 9, costUSD: 0.2 })
    expect(rest).toEqual({ ...emptyModelUsage(), costUSD: 0.3 })
  })

  test('remainingModelUsage is undefined when nothing but float noise is left', () => {
    expect(remainingModelUsage(FULL, FULL)).toBeUndefined()
    expect(
      remainingModelUsage(
        { ...emptyModelUsage(), costUSD: 0.1 + 0.2 },
        { ...emptyModelUsage(), costUSD: 0.3 },
      ),
    ).toBeUndefined()
  })

  test('a token left over is kept even at zero cost', () => {
    expect(
      remainingModelUsage({ ...emptyModelUsage(), outputTokens: 1 }, emptyModelUsage()),
    ).toEqual({ ...emptyModelUsage(), outputTokens: 1 })
  })
})
