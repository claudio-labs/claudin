import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gates, parseArgs, reapLeaks } from './tool-gaps-ab.ts'
import { emptyMechanisms, type Mechanisms } from './toolGapsMechanisms.ts'

type Result = Parameters<typeof gates>[0][number]

function result(arm: string, over: { cost?: number; calls?: number; hidden?: number; leaks?: number; m?: Partial<Mechanisms> } = {}): Result {
  return {
    arm,
    rep: 1,
    sessionId: 's',
    phases: [{ phase: 1, timedOut: false, subtype: 'success' } as Result['phases'][number]],
    hidden: [{ ok: true, pass: over.hidden ?? 10, fail: 0, failed: [] }],
    tests: [],
    leaks: [Array.from({ length: over.leaks ?? 0 }, (_, i) => ({ pid: i, command: 'bun src/server.ts' }))],
    committed: null,
    costUsd: over.cost ?? 1,
    apiCalls: over.calls ?? 40,
    subagentCalls: 0,
    mechanisms: { ...emptyMechanisms(), dedicatedReads: 8, bashReads: 2, ...over.m },
  }
}

const verdictOf = (rs: Result[], gate: string) => gates(rs).find(g => g.gate === gate)?.verdict

describe('gates', () => {
  const baseWithProblems = () =>
    Array.from({ length: 5 }, () =>
      result('base', { cost: 1, calls: 40, leaks: 1, m: { taskToolSearchAfterPlan: 1, taskListBeforeFirstUpdate: 1, docsOutlined: 2, docsOutlineThenBody: 1, processBash: 3 } }),
    )
  const goodCombo = () => Array.from({ length: 5 }, () => result('combo', { cost: 0.9, calls: 36, m: { taskStops: 1, processBash: 0 } }))

  test('a combo that removes every problem passes every lever', () => {
    const rs = [...baseWithProblems(), ...goodCombo()]
    for (const gate of ['correctness', 'tasks', 'outline', 'processes', 'file-tools note off', 'cost and calls', 'diff wording (branch arms)']) {
      expect([gate, verdictOf(rs, gate)]).toEqual([gate, 'PASS'])
    }
  })

  test('a lever the base never shows in 3 of 5 sessions has no headroom', () => {
    const base = Array.from({ length: 5 }, (_, i) => result('base', { m: { docsOutlined: i < 2 ? 1 : 0 } }))
    expect(verdictOf([...base, ...goodCombo()], 'outline')).toBe('NO HEADROOM')
  })

  test('a combo that costs more than the base fails cost, whatever its mechanisms', () => {
    const combo = goodCombo().map(r => ({ ...r, costUsd: 1.2 }))
    expect(verdictOf([...baseWithProblems(), ...combo], 'cost and calls')).toBe('FAIL')
  })

  test('the ceiling is the higher of base and placebo', () => {
    const placebo = Array.from({ length: 5 }, () => result('placebo', { cost: 0.8 }))
    const combo = goodCombo().map(r => ({ ...r, costUsd: 0.95 }))
    expect(verdictOf([...baseWithProblems(), ...placebo, ...combo], 'cost and calls')).toBe('PASS')
  })

  test('one leaked server in the combo fails processes; fewer hidden passes fail correctness', () => {
    const combo = goodCombo()
    combo[0] = result('combo', { leaks: 1, m: { taskStops: 1 } })
    expect(verdictOf([...baseWithProblems(), ...combo], 'processes')).toBe('FAIL')
    const weaker = goodCombo().map(r => ({ ...r, hidden: [{ ok: false, pass: 8, fail: 2, failed: [] }] }))
    expect(verdictOf([...baseWithProblems(), ...weaker], 'correctness')).toBe('FAIL')
  })

  test('a | cat re-run in a branch arm fails the diff wording; in the main arm it does not', () => {
    const main = [result('main', { m: { diffCatReruns: 2 } })]
    expect(verdictOf([...baseWithProblems(), ...goodCombo(), ...main], 'diff wording (branch arms)')).toBe('PASS')
    const combo = goodCombo()
    combo[0] = result('combo', { m: { diffCatReruns: 1, taskStops: 1 } })
    expect(verdictOf([...baseWithProblems(), ...combo], 'diff wording (branch arms)')).toBe('FAIL')
  })
})

describe('parseArgs', () => {
  test('the main arm refuses to run on the branch build', () => {
    expect(() => parseArgs(['--only=main,base'])).toThrow('--bin=main:')
    expect(parseArgs(['--only=main,base', '--bin=main:/wt/bin/claudin']).bins.main).toBe('/wt/bin/claudin')
  })

  test('the defaults are Sonnet 5.5 at medium effort, both phases', () => {
    const a = parseArgs(['--only=combo'])
    expect([a.model, a.effort, a.phases]).toEqual(['claude-sonnet-5-5', 'medium', [1, 2]])
  })

  test('an unknown arm or flag is an error', () => {
    expect(() => parseArgs(['--only=turbo'])).toThrow('unknown arm')
    expect(() => parseArgs(['--fast'])).toThrow('unknown argument')
  })
})

describe('reapLeaks', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test.skipIf(process.platform !== 'linux')('kills what runs inside the workspace and leaves the rest', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'tga-leak-'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'tga-other-'))
    dirs.push(ws, elsewhere)
    const inside = spawn('sleep', ['300'], { cwd: ws, stdio: 'ignore' })
    const outside = spawn('sleep', ['300'], { cwd: elsewhere, stdio: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 100))
      const leaks = reapLeaks(ws)
      expect(leaks.map(l => l.pid)).toEqual([inside.pid!])
      expect(leaks[0]!.command).toBe('sleep 300')
      await new Promise(r => setTimeout(r, 100))
      expect(inside.exitCode !== null || inside.signalCode !== null).toBe(true)
      expect(outside.exitCode === null && outside.signalCode === null).toBe(true)
    } finally {
      inside.kill('SIGKILL')
      outside.kill('SIGKILL')
    }
  })
})
