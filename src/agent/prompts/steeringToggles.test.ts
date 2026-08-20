import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  isAntiNarrationEnabled,
  isPlanNoopGuardEnabled,
  isSubagentNotesEnabled,
  isWorkContractEnabled,
} from 'src/agent/prompts/steeringToggles.js'

const VARS = [
  'CLAUDIN_WORK_CONTRACT',
  'CLAUDIN_ANTI_NARRATION',
  'CLAUDIN_SUBAGENT_NOTES',
  'CLAUDIN_PLAN_NOOP_GUARD',
] as const

afterEach(() => {
  for (const name of VARS) delete process.env[name]
})

const CASES: Array<{ name: (typeof VARS)[number]; fn: () => boolean }> = [
  { name: 'CLAUDIN_WORK_CONTRACT', fn: isWorkContractEnabled },
  { name: 'CLAUDIN_ANTI_NARRATION', fn: isAntiNarrationEnabled },
  { name: 'CLAUDIN_SUBAGENT_NOTES', fn: isSubagentNotesEnabled },
  { name: 'CLAUDIN_PLAN_NOOP_GUARD', fn: isPlanNoopGuardEnabled },
]

// CLAUDIN_PLAN_NOOP_GUARD is the one opt-IN toggle in this file — the A/B found
// no benefit, so the clause has to be asked for. Its value table is the mirror
// image of the others', which is why the shared loop below runs over DEFAULT_ON
// instead of CASES: a single loop covering both dispositions would have to
// branch per var, and the branch is exactly what would stop failing if someone
// flipped a default back.
const OPT_IN = 'CLAUDIN_PLAN_NOOP_GUARD'
const DEFAULT_ON = CASES.filter(({ name }) => name !== OPT_IN)

for (const { name, fn } of DEFAULT_ON) {
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

describe(OPT_IN, () => {
  test('defaults OFF when unset', () => {
    // The measured disposition: 1 no-op in 94 tool turns without the clause vs
    // 3 in 85 with it. Shipping it on would be steering on a null result.
    delete process.env[OPT_IN]
    expect(isPlanNoopGuardEnabled()).toBe(false)
  })

  for (const value of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
    test(`${JSON.stringify(value)} turns it on`, () => {
      process.env[OPT_IN] = value
      expect(isPlanNoopGuardEnabled()).toBe(true)
    })
  }

  // Unlike the default-ON toggles, an unrecognized value here resolves OFF: the
  // clause is opt-in, so anything that is not an explicit yes leaves the
  // plan-mode attachment byte-identical to what ships.
  for (const value of ['0', 'false', 'no', 'off', '', 'maybe']) {
    test(`${JSON.stringify(value)} leaves it off`, () => {
      process.env[OPT_IN] = value
      expect(isPlanNoopGuardEnabled()).toBe(false)
    })
  }
})

describe('toggle independence', () => {
  test('each var moves only its own lane', () => {
    // Driven off CASES so a new toggle is covered the moment it is added: an
    // A/B that silently subtracted a second section would attribute one
    // block's effect to another.
    // Every var starts explicitly ON rather than unset, so the opt-in toggle
    // participates: left unset its lane reads false for a reason that has
    // nothing to do with the var under test, and the assertion could not tell
    // a leak from the default.
    for (const { name } of CASES) process.env[name] = '1'
    for (const { name, fn: subject } of CASES) {
      process.env[name] = '0'
      for (const other of CASES) {
        expect(other.fn()).toBe(other.fn === subject ? false : true)
      }
      process.env[name] = '1'
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
