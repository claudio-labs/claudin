import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  isAntiNarrationEnabled,
  isSubagentNotesEnabled,
  isWorkContractEnabled,
} from './steeringToggles.js'

const VARS = [
  'CLAUDIN_WORK_CONTRACT',
  'CLAUDIN_ANTI_NARRATION',
  'CLAUDIN_SUBAGENT_NOTES',
] as const

afterEach(() => {
  for (const name of VARS) delete process.env[name]
})

const CASES: Array<{ name: (typeof VARS)[number]; fn: () => boolean }> = [
  { name: 'CLAUDIN_WORK_CONTRACT', fn: isWorkContractEnabled },
  { name: 'CLAUDIN_ANTI_NARRATION', fn: isAntiNarrationEnabled },
  { name: 'CLAUDIN_SUBAGENT_NOTES', fn: isSubagentNotesEnabled },
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
    // Driven off CASES so a new toggle is covered the moment it is added: an
    // A/B that silently subtracted a second section would attribute one
    // block's effect to another.
    for (const { name, fn: subject } of CASES) {
      process.env[name] = '0'
      for (const other of CASES) {
        expect(other.fn()).toBe(other.fn === subject ? false : true)
      }
      delete process.env[name]
    }
  })
})

describe('cache-prefix contract', () => {
  // The work-contract and anti-narration resolvers read at call time from
  // inside the STATIC (pre-boundary) half of the system prompt. That is only
  // sound while the value is constant for the process. A future edit that made
  // one of them consult settings, the active provider or any mid-session state
  // would fragment the cacheScope:'global' prefix on a bit that flips between
  // turns — the exact failure the module header warns about — so pin the
  // shape: nothing but a process.env read. isSubagentNotesEnabled is rendered
  // per sub-agent spawn rather than into that prefix, but the same shape rule
  // keeps it cheap and side-effect free.
  test('resolvers read process.env and nothing else', () => {
    const src = readFileSync(
      new URL('./steeringToggles.ts', import.meta.url),
      'utf8',
    )
    const body = src.slice(src.indexOf('export function'))
    expect(body).not.toMatch(/getInitialSettings|getGlobalConfig|tryGetActiveProvider|getCwd/)
    // One env read per resolver, counted from the file itself so adding a
    // toggle does not require editing a magic number — what is pinned is the
    // ratio, not the total.
    const resolvers = body.match(/^export function/gm)?.length ?? 0
    expect(resolvers).toBe(CASES.length)
    expect(body.match(/process\.env\./g)).toHaveLength(resolvers)
  })
})
