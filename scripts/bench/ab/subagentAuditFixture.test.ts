import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { auditFixture, CHAIN_LENGTH, CHAINS, gradeAudit, observedChains, referenceReply } from './subagentAuditFixture'

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
      const { chains } = auditFixture(rep)
      expect(chains).toHaveLength(CHAINS)
      for (const c of chains) expect(c.nodes).toHaveLength(CHAIN_LENGTH)
      expect(observedChains(writeRep(rep), chains.map(c => c.start))).toEqual(chains)
    }
  })

  test('a rep is deterministic, and reps differ', () => {
    expect(auditFixture(4)).toEqual(auditFixture(4))
    expect(auditFixture(4).chains).not.toEqual(auditFixture(5).chains)
  })

  test('a body calls its next hop in the same shape as its helpers, sometimes under another name', () => {
    const { files, chains } = auditFixture(1)
    let renamed = 0
    for (const c of chains) {
      c.nodes.slice(0, -1).forEach((n, i) => {
        const [file, line] = n.defined.split(':')
        const lines = files[file!]!.split('\n')
        const end = lines.indexOf('}', Number(line))
        const body = lines.slice(Number(line), end)
        const calls = body.filter(l => /^ {2}acc = \w+\(acc, \d+\)$/.test(l))
        // Every step, the cross-module call included, is `acc = f(acc, N)`.
        expect(calls.length).toBe(body.length - 2)
        if (!body.some(l => l.includes(`${c.nodes[i + 1]!.name}(`))) renamed++
      })
    }
    expect(renamed).toBeGreaterThan(0)
  })
})

describe('gradeAudit', () => {
  const { chains } = auditFixture(1)

  test('the reference reply scores full marks, an empty one none', () => {
    expect(gradeAudit(referenceReply(chains), chains).score).toBe(CHAINS * CHAIN_LENGTH)
    expect(gradeAudit('', chains).score).toBe(0)
  })

  test('a point per function at its position with its definition; a wrong hop costs the rest of the chain', () => {
    const c = chains[0]!
    const wrongLine = gradeAudit(referenceReply([{ ...c, nodes: c.nodes.map((n, i) => (i === 1 ? { ...n, defined: `${n.defined}0` } : n)) }]), [c])
    expect(wrongLine.score).toBe(CHAIN_LENGTH - 1)
    // A hop to the wrong function shifts every position after it.
    const wrongHop = gradeAudit(referenceReply([{ ...c, nodes: [c.nodes[0]!, chains[1]!.nodes[3]!, ...c.nodes.slice(2)] }]), [c])
    expect(wrongHop.score).toBe(CHAIN_LENGTH - 1)
    const stopped = gradeAudit(referenceReply([{ ...c, nodes: c.nodes.slice(0, 4) }]), [c])
    expect(stopped.score).toBe(4)
  })

  test('a preamble naming every start does not hide the lines below it, and "at" or parentheses separate', () => {
    const reply = `I traced ${chains.map(c => c.start).join(', ')}.\n\n${chains.map(c => c.nodes.map(n => `${n.name} at ${n.defined}`).join(' → ')).join('\n')}`
    expect(gradeAudit(reply, chains).score).toBe(CHAINS * CHAIN_LENGTH)
    const parens = chains.map(c => c.nodes.map(n => `${n.name} (${n.defined})`).join(' -> ')).join('\n')
    expect(gradeAudit(parens, chains).score).toBe(CHAINS * CHAIN_LENGTH)
  })
})
