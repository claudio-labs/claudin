import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { auditFixture, gradeAudit, observedTargets, referenceReply, TARGETS } from './subagentAuditFixture'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function writeRep(rep: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-fixture-'))
  dirs.push(dir)
  for (const [rel, text] of Object.entries(auditFixture(rep).files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

describe('auditFixture', () => {
  test('the key the generator writes is what the files say, for several reps', () => {
    for (const rep of [1, 2, 3, 7]) {
      const { targets } = auditFixture(rep)
      expect(targets).toHaveLength(TARGETS)
      expect(observedTargets(writeRep(rep), targets.map(t => t.name))).toEqual(targets)
    }
  })

  test('a rep is deterministic, and reps differ', () => {
    expect(auditFixture(4)).toEqual(auditFixture(4))
    expect(auditFixture(4).targets).not.toEqual(auditFixture(5).targets)
  })

  test('some callers are reached only through another name — a grep for the target misses them', () => {
    const { files, targets } = auditFixture(1)
    const hidden = targets.flatMap(t =>
      t.callers.filter(c => {
        const [file, line] = c.split(':')
        return !files[file!]!.split('\n')[Number(line) - 1]!.includes(`${t.name}(`)
      }),
    )
    expect(hidden.length).toBeGreaterThan(0)
  })
})

describe('gradeAudit', () => {
  const { targets } = auditFixture(1)

  test('the reference reply scores full marks, an empty one none', () => {
    expect(gradeAudit(referenceReply(targets), targets).score).toBe(TARGETS * 3)
    expect(gradeAudit('', targets).score).toBe(0)
  })

  test('each part is its own point: definition, the exact caller set, tested', () => {
    const t = targets.find(x => x.callers.length > 0)!
    const one = [t]
    const wrongLine = gradeAudit(referenceReply([{ ...t, defined: `${t.defined}0` }]), one)
    expect(wrongLine.targets[0]).toMatchObject({ defined: false, callers: true, tested: true })
    const extraCaller = gradeAudit(referenceReply([{ ...t, callers: [...t.callers, 'src/billing/ledger.ts:999'] }]), one)
    expect(extraCaller.targets[0]).toMatchObject({ defined: true, callers: false, tested: true })
    const flipped = gradeAudit(referenceReply([{ ...t, tested: !t.tested }]), one)
    expect(flipped.targets[0]).toMatchObject({ defined: true, callers: true, tested: false })
  })

  test('a preamble naming every target does not hide the blocks below it', () => {
    const reply = `I audited ${targets.map(t => t.name).join(', ')}.\n\n${referenceReply(targets)}`
    expect(gradeAudit(reply, targets).score).toBe(TARGETS * 3)
  })
})
