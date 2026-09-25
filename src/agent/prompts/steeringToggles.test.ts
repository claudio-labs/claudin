import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  isLeanSystemPromptEnabled,
  isOnePatchChangeEnabled,
  isResponseChainsEnabled,
  isSubagentBatchingEnabled,
  isSubagentNotesEnabled,
  isWorkContractEnabled,
} from 'src/agent/prompts/steeringToggles.js'

const VARS = [
  'CLAUDIN_WORK_CONTRACT',
  'CLAUDIN_SUBAGENT_NOTES',
  'CLAUDIN_LEAN_SYSTEM_PROMPT',
  'CLAUDIN_RESPONSE_CHAINS',
  'CLAUDIN_ONE_PATCH_CHANGE',
  'CLAUDIN_SUBAGENT_BATCHING',
] as const

afterEach(() => {
  for (const name of VARS) delete process.env[name]
})

const CASES: Array<{ name: (typeof VARS)[number]; fn: () => boolean }> = [
  { name: 'CLAUDIN_WORK_CONTRACT', fn: isWorkContractEnabled },
  { name: 'CLAUDIN_SUBAGENT_NOTES', fn: isSubagentNotesEnabled },
  { name: 'CLAUDIN_LEAN_SYSTEM_PROMPT', fn: isLeanSystemPromptEnabled },
]

// The request-count levers (2026-09-24) are the opposite shape: opt-in A/B
// arms, OFF until promoted. Only an explicit truthy value adds their text, so
// a stray or empty value cannot change a prompt.
const OPT_IN: Array<{ name: (typeof VARS)[number]; fn: () => boolean }> = [
  { name: 'CLAUDIN_RESPONSE_CHAINS', fn: isResponseChainsEnabled },
  { name: 'CLAUDIN_ONE_PATCH_CHANGE', fn: isOnePatchChangeEnabled },
  { name: 'CLAUDIN_SUBAGENT_BATCHING', fn: isSubagentBatchingEnabled },
]

// Every toggle here is default-ON: the env can only subtract a section (or,
// for CLAUDIN_LEAN_SYSTEM_PROMPT, restore the pre-v2 text), never add one.
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

for (const { name, fn } of OPT_IN) {
  describe(name, () => {
    test('defaults OFF when unset', () => {
      delete process.env[name]
      expect(fn()).toBe(false)
    })

    for (const value of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
      test(`${JSON.stringify(value)} turns it on`, () => {
        process.env[name] = value
        expect(fn()).toBe(true)
      })
    }

    for (const value of ['0', 'false', 'off', '', 'maybe']) {
      test(`${JSON.stringify(value)} leaves it off`, () => {
        process.env[name] = value
        expect(fn()).toBe(false)
      })
    }
  })
}

describe('toggle independence', () => {
  test('each var moves only its own lane', () => {
    // Driven off CASES so a new toggle is covered the moment it is added: an
    // A/B that silently subtracted a second section would attribute one
    // block's effect to another.
    // Every var starts explicitly ON rather than unset, so a lane reading
    // false can only be the subtraction under test.
    for (const { name } of CASES) process.env[name] = '1'
    for (const { name, fn: subject } of CASES) {
      process.env[name] = '0'
      for (const other of CASES) {
        expect(other.fn()).toBe(other.fn === subject ? false : true)
      }
      process.env[name] = '1'
    }
  })

  test('each opt-in var moves only its own lane', () => {
    for (const { name, fn: subject } of OPT_IN) {
      for (const other of OPT_IN) delete process.env[other.name]
      process.env[name] = '1'
      for (const other of OPT_IN) {
        expect(other.fn()).toBe(other.fn === subject)
      }
      // The default-ON toggles do not move with it.
      for (const lane of CASES) expect(lane.fn()).toBe(true)
    }
  })
})

describe('cache-prefix contract', () => {
  // The work-contract resolver reads at call time from inside the STATIC
  // (pre-boundary) half of the system prompt. That is only
  // sound while the value is constant for the process. A future edit that made
  // it consult settings, the active provider or any mid-session state
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
    expect(resolvers).toBe(CASES.length + OPT_IN.length)
    expect(body.match(/process\.env\./g)).toHaveLength(resolvers)
  })
})
