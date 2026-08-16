import { existsSync } from 'fs'
import { describe, expect, test } from 'bun:test'
import {
  BUILD_SCRIPT_PATH,
  loadShippedFeatureFlags,
  parseFeatureFlags,
} from './parseFeatureFlags'

// Guards the shared parser behind the two build-invariant suites and the
// system-prompt dump. Both of those fail OPEN on a parser that returns an empty
// map — every flag then reads "not enabled" — so the parser needs its own test.

const SAMPLE = `
const somethingElse = { EARLY_FLAG: true }

const featureFlags: Record<string, boolean> = {
  ON_FLAG: true,              // trailing comment
  OFF_FLAG: false,
  DIGIT_9_FLAG: true,
  lowercase_ignored: true,
}

const later = { LATE_FLAG: true }
`

describe('parseFeatureFlags', () => {
  test('reads the name/value pairs inside the featureFlags block', () => {
    expect(parseFeatureFlags(SAMPLE)).toEqual({
      ON_FLAG: true,
      OFF_FLAG: false,
      DIGIT_9_FLAG: true,
    })
  })

  test('is bounded by the block — flags in other objects are not shipped flags', () => {
    const flags = parseFeatureFlags(SAMPLE)
    expect(flags).not.toHaveProperty('EARLY_FLAG')
    expect(flags).not.toHaveProperty('LATE_FLAG')
  })

  test('throws instead of returning {} when the block is gone', () => {
    // The fail-open shape is the dangerous one: a silent {} would make every
    // guard report "flag not enabled" and pass.
    expect(() => parseFeatureFlags('const other = {\n}\n')).toThrow(
      /could not find featureFlags/,
    )
  })
})

describe('loadShippedFeatureFlags', () => {
  test('points at the real build.ts', () => {
    expect(existsSync(BUILD_SCRIPT_PATH)).toBe(true)
    expect(BUILD_SCRIPT_PATH.endsWith('build.ts')).toBe(true)
  })

  test('parses the shipped map', () => {
    const flags = loadShippedFeatureFlags()
    expect(Object.keys(flags).length).toBeGreaterThan(20)
    // Presence, not value: the value is build.ts's call to make.
    expect(flags).toHaveProperty('DUMP_SYSTEM_PROMPT')
    expect(flags).toHaveProperty('MCP_SKILLS')
    for (const value of Object.values(flags)) expect(typeof value).toBe('boolean')
    // Both arms are represented, so a parser that collapsed to one is caught.
    expect(Object.values(flags)).toContain(true)
    expect(Object.values(flags)).toContain(false)
  })
})
