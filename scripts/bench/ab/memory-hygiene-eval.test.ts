import { describe, expect, test } from 'bun:test'
import { MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from 'src/memory/memdir/entrypointFit.js'
import { evaluateHygieneGates, type HygieneGrade, selfTest } from './memory-hygiene-eval'
import { INDEX_CAP } from './memory-write-ab'

describe('memory-hygiene-eval grader', () => {
  test('every self-test gate holds', () => {
    const failed = selfTest().filter(([, ok]) => !ok)
    expect(failed).toEqual([])
  })

  test("the evals' index caps mirror the source", () => {
    expect(INDEX_CAP).toEqual({ lines: MAX_ENTRYPOINT_LINES, bytes: MAX_ENTRYPOINT_BYTES })
  })

  const grade = (over: Partial<HygieneGrade> = {}): HygieneGrade => ({
    S1: true,
    S2: true,
    S4: true,
    S3: true,
    E1: true,
    E2: true,
    E3: true,
    E4: true,
    E5: true,
    deleted: 3,
    problems: [],
    ...over,
  })
  const roles = { base: 'base', next: 'claudindev', placebo: 'placebo' }

  test('one deleted control in one run fails the hard S1 gate', () => {
    const sessions = [
      { arm: 'claudindev', grade: grade(), dreamUsd: 2 },
      { arm: 'claudindev', grade: grade({ S1: false }), dreamUsd: 2 },
      { arm: 'claudindev', grade: grade(), dreamUsd: 2 },
      { arm: 'base', grade: grade({ deleted: 0 }), dreamUsd: 2 },
    ]
    const gates = evaluateHygieneGates(sessions, roles, 3)
    expect(gates.find(g => g.gate.startsWith('S1'))?.ok).toBe(false)
    expect(gates.find(g => g.gate === 'E1')?.ok).toBe(true)
  })

  test('one memory deleted outside the planted mess, in one run, fails the hard S4 gate', () => {
    const sessions = [
      { arm: 'claudindev', grade: grade(), dreamUsd: 2 },
      { arm: 'claudindev', grade: grade({ S4: false, deleted: 53 }), dreamUsd: 2 },
      { arm: 'claudindev', grade: grade(), dreamUsd: 2 },
      { arm: 'base', grade: grade({ deleted: 0 }), dreamUsd: 2 },
    ]
    const gates = evaluateHygieneGates(sessions, roles, 3)
    expect(gates.find(g => g.gate.startsWith('S4'))?.ok).toBe(false)
    expect(gates.find(g => g.gate.startsWith('S1'))?.ok).toBe(true)
  })

  test('an effect check passes at two of three, and cost is flagged past +50%', () => {
    const sessions = [
      { arm: 'claudindev', grade: grade({ E2: false }), dreamUsd: 3.1 },
      { arm: 'claudindev', grade: grade(), dreamUsd: 3.2 },
      { arm: 'claudindev', grade: grade(), dreamUsd: 3.3 },
      { arm: 'base', grade: grade({ deleted: 0 }), dreamUsd: 2 },
    ]
    const gates = evaluateHygieneGates(sessions, roles, 3)
    expect(gates.find(g => g.gate === 'E2')?.ok).toBe(true)
    expect(gates.find(g => g.gate === 'C cost')?.ok).toBe(false)
    expect(gates.find(g => g.gate === 'M deletes')?.ok).toBe(true)
  })
})
