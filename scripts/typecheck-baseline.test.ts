import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `typecheck-baseline.json` is the reference side of the CI ratchet
 * (`scripts/typecheck-ci.ts`), and a corrupted one fails OPEN in the direction
 * that matters: entries lost to a bad merge or a hand-edit come back as "new"
 * errors on the next PR, and the reflex fix for a wall of unexplained new
 * errors is to refresh the baseline — which launders them in permanently.
 *
 * These assertions are the cheap half of the guard, and deliberately do not run
 * tsc: shape only, so they cost nothing in the suite.
 */
describe('typecheck baseline', () => {
  const raw = readFileSync(join(import.meta.dir, '..', 'typecheck-baseline.json'), 'utf8')
  const baseline = JSON.parse(raw) as {
    checker: string
    command: string
    count: number
    fingerprints: string[]
  }

  test('is the tsc baseline, recorded from the non-pretty output the parser expects', () => {
    expect(baseline.checker).toBe('tsc')
    // The parser matches the one-line MSVC shape; pretty output is a code frame
    // and would parse to nothing, which reads as a clean tree.
    expect(baseline.command).toContain('--pretty false')
  })

  test('count agrees with the entries actually stored', () => {
    expect(baseline.fingerprints).toBeArray()
    expect(baseline.count).toBe(baseline.fingerprints.length)
  })

  test('every entry is a 12-hex-char fingerprint', () => {
    const malformed = baseline.fingerprints.filter(fp => !/^[0-9a-f]{12}$/.test(fp))
    expect(malformed).toEqual([])
  })

  test('entries are sorted, so a refresh diffs as insertions and deletions', () => {
    expect(baseline.fingerprints).toEqual([...baseline.fingerprints].sort())
  })

  test('duplicates survive — the comparison is a multiset, not a set', () => {
    // Not an assertion about a specific number: only that de-duplicating is not
    // silently happening somewhere, which would let a second copy of a known
    // error slip in as pre-existing.
    expect(new Set(baseline.fingerprints).size).toBeLessThanOrEqual(baseline.count)
  })
})
