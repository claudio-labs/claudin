import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  isAntiNarrationEnabled,
  isWorkContractEnabled,
} from './steeringToggles.js'

const VARS = ['CLAUDIN_WORK_CONTRACT', 'CLAUDIN_ANTI_NARRATION'] as const

afterEach(() => {
  for (const name of VARS) delete process.env[name]
})

const CASES: Array<{ name: (typeof VARS)[number]; fn: () => boolean }> = [
  { name: 'CLAUDIN_WORK_CONTRACT', fn: isWorkContractEnabled },
  { name: 'CLAUDIN_ANTI_NARRATION', fn: isAntiNarrationEnabled },
]

for (const { name, fn } of CASES) {
  describe(name, () => {
    test('defaults ON when unset', () => {
      delete process.env[name]
      expect(fn()).toBe(true)
    })

    for (const value of ['0', 'false', 'no', 'off', 'OFF', ' False ']) {
      test(`${JSON.stringify(value)} turns it off`, () => {
        process.env[name] = value
        expect(fn()).toBe(false)
      })
    }

    // The A/B harness sets the ON side explicitly rather than unsetting, so
    // the truthy spellings have to resolve ON too — and an unrecognized value
    // must not silently subtract a section from the cached prefix.
    for (const value of ['1', 'true', 'yes', 'on', '', 'maybe']) {
      test(`${JSON.stringify(value)} leaves it on`, () => {
        process.env[name] = value
        expect(fn()).toBe(true)
      })
    }
  })
}

describe('toggle independence', () => {
  test('each var moves only its own lane', () => {
    process.env.CLAUDIN_WORK_CONTRACT = '0'
    expect(isWorkContractEnabled()).toBe(false)
    expect(isAntiNarrationEnabled()).toBe(true)

    delete process.env.CLAUDIN_WORK_CONTRACT
    process.env.CLAUDIN_ANTI_NARRATION = '0'
    expect(isWorkContractEnabled()).toBe(true)
    expect(isAntiNarrationEnabled()).toBe(false)
  })
})

describe('cache-prefix contract', () => {
  // These two read at call time from inside the STATIC (pre-boundary) half of
  // the system prompt. That is only sound while the value is constant for the
  // process. A future edit that made either of them consult settings, the
  // active provider or any mid-session state would fragment the
  // cacheScope:'global' prefix on a bit that flips between turns — the exact
  // failure the module header warns about — so pin the shape: nothing but a
  // process.env read.
  test('resolvers read process.env and nothing else', () => {
    const src = readFileSync(
      new URL('./steeringToggles.ts', import.meta.url),
      'utf8',
    )
    const body = src.slice(src.indexOf('export function'))
    expect(body).not.toMatch(/getInitialSettings|getGlobalConfig|tryGetActiveProvider|getCwd/)
    expect(body.match(/process\.env\./g)).toHaveLength(2)
  })
})
