import { describe, expect, test } from 'bun:test'
import { hintGc, pickGcStrategy } from 'src/shared/proc/gc.js'

describe('pickGcStrategy', () => {
  test('prefers Bun.gc whenever the Bun runtime is present', () => {
    expect(pickGcStrategy(true, true)).toBe('bun')
    expect(pickGcStrategy(true, false)).toBe('bun')
  })

  test('falls back to the exposed global under Node', () => {
    expect(pickGcStrategy(false, true)).toBe('global')
  })

  // The shipped binary before this module existed: Bun, but with no
  // --expose-gc, so neither entry point was reachable through globalThis and
  // `globalThis.gc?.()` collected nothing while reading as if it did.
  test('reports none when neither entry point exists', () => {
    expect(pickGcStrategy(false, false)).toBe('none')
  })
})

describe('hintGc', () => {
  test('collects on this runtime without throwing, async and sync', () => {
    expect(() => hintGc()).not.toThrow()
    expect(() => hintGc(true)).not.toThrow()
  })
})
