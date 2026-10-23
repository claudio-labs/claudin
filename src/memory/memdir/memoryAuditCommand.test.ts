import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { auditDirsFor, formatMemoryAudit, memoryAuditHandler } from 'src/memory/memdir/memoryAuditCommand.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

describe('auditDirsFor', () => {
  const session = testMemoryDirs({ private: '/repo/.claudin/memory', team: '/repo/.claudin/memory/team' })

  test('the committed team dir is covered with memory off, and when a setting moved the session dirs', () => {
    expect(auditDirsFor([], '/repo/.claudin/memory/team/')).toEqual([
      { scope: 'team', root: '/repo/.claudin/memory/team/', index: '/repo/.claudin/memory/team/MEMORY.md' },
    ])
    const moved = testMemoryDirs({ private: '/elsewhere/memory', team: '/elsewhere/memory/team' })
    expect(auditDirsFor(moved, '/repo/.claudin/memory/team/').map(d => d.root)).toEqual([
      '/elsewhere/memory/',
      '/elsewhere/memory/team/',
      '/repo/.claudin/memory/team/',
    ])
  })

  test('it is not listed twice when the session already has it, and nothing is added outside a repo', () => {
    expect(auditDirsFor(session, '/repo/.claudin/memory/team/')).toEqual(session)
    expect(auditDirsFor(session, null)).toEqual(session)
  })
})

// The handler's own wiring, in source: with memory switched off by the
// environment, the committed team dir of the repo the cwd is in is still
// audited. The e2e suite pins the same through the bundle.
describe('memoryAuditHandler', () => {
  const FLAG = 'CLAUDIN_DISABLE_AUTO_MEMORY'
  let root: string
  let prior: string | undefined
  const logged: string[] = []
  const realLog = console.log

  beforeAll(() => {
    prior = process.env[FLAG]
    process.env[FLAG] = '1'
    root = mkdtempSync(join(tmpdir(), 'audit-handler-'))
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, '.claudin', 'memory', 'team', 'bugs'), { recursive: true })
    writeFileSync(join(root, '.claudin', 'memory', 'team', 'bugs', 'x.md'), `token: ghp_${'x'.repeat(36)}\n`)
    writeFileSync(join(root, '.claudin', 'memory', 'team', 'MEMORY.md'), '- [X](bugs/x.md) — x\n')
    console.log = (line: string) => void logged.push(line)
  })
  afterAll(() => {
    console.log = realLog
    if (prior === undefined) delete process.env[FLAG]
    else process.env[FLAG] = prior
    rmSync(root, { recursive: true, force: true })
  })

  test('memory off still audits <gitRoot>/.claudin/memory/team/ and fails on its secret', async () => {
    const code = await runWithCwdOverride(root, () => memoryAuditHandler({ json: true }))
    expect(code).toBe(1)
    expect(JSON.parse(logged.at(-1)!).findings).toEqual([
      { kind: 'secret', path: '.claudin/memory/team/bugs/x.md', labels: [expect.any(String)] },
    ])
  })
})

const CWD = '/repo'
const secret ={ kind: 'secret' as const, path: '/repo/.claudin/memory/team/bugs/x.md', labels: ['GitHub PAT'] }

describe('formatMemoryAudit', () => {
  test('no findings: one line, exit 0', () => {
    expect(formatMemoryAudit({ files: 229, findings: [] }, CWD)).toEqual({
      output: 'Memory audit: 229 files, no findings.',
      exitCode: 0,
    })
  })

  test('a secret in team memory: a line per file relative to the cwd, the remedy, exit 1', () => {
    const { output, exitCode } = formatMemoryAudit({ files: 3, findings: [secret] }, CWD)
    expect(exitCode).toBe(1)
    expect(output.split('\n')).toEqual([
      'Memory audit: 3 files, 1 with findings.',
      '.claudin/memory/team/bugs/x.md: secret-shaped content (GitHub PAT)',
      'Team memory is git-tracked: remove the secret, and rotate it if it was ever committed.',
    ])
  })

  test('a path outside the cwd stays absolute', () => {
    const { output } = formatMemoryAudit({ files: 1, findings: [{ ...secret, path: '/elsewhere/team/x.md' }] }, CWD)
    expect(output).toContain('/elsewhere/team/x.md: secret-shaped content')
  })

  test('an expired memory is listed with what to do, and exits 0 with no remedy for a secret', () => {
    const expired = { kind: 'expired' as const, scope: 'private' as const, path: '/repo/.claudin/memory/project-oncall.md', expires: '2026-09-30' }
    const { output, exitCode } = formatMemoryAudit({ files: 2, findings: [expired] }, CWD)
    expect(exitCode).toBe(0)
    expect(output.split('\n')).toEqual([
      'Memory audit: 2 files, 1 with findings.',
      '.claudin/memory/project-oncall.md: expired 2026-09-30 — re-verify it, then move the date or remove the memory',
    ])
    expect(formatMemoryAudit({ files: 2, findings: [secret, expired] }, CWD).exitCode).toBe(1)
  })

  test('hidden characters in team memory: their labels, their own remedy, exit 1', () => {
    const hidden = { kind: 'hidden-text' as const, path: '/repo/.claudin/memory/team/x.md', labels: ['bidi control'] }
    const { output, exitCode } = formatMemoryAudit({ files: 2, findings: [hidden] }, CWD)
    expect(exitCode).toBe(1)
    expect(output.split('\n')).toEqual([
      'Memory audit: 2 files, 1 with findings.',
      '.claudin/memory/team/x.md: hidden characters (bidi control)',
      'Hidden characters change what a reviewer of the commit sees, not what the model reads: remove them.',
    ])
  })

  test('link findings are listed with what to do, and never fail the audit', () => {
    const findings = [
      { kind: 'broken-link' as const, scope: 'team' as const, path: '/repo/.claudin/memory/team/a.md', target: '[[mine]]' },
      { kind: 'unindexed' as const, scope: 'team' as const, path: '/repo/.claudin/memory/team/lost.md' },
      { kind: 'duplicate-name' as const, scope: 'private' as const, path: '/repo/.claudin/memory/b.md', name: 'same' },
    ]
    const { output, exitCode } = formatMemoryAudit({ files: 5, findings }, CWD)
    expect(exitCode).toBe(0)
    expect(output.split('\n')).toEqual([
      'Memory audit: 5 files, 3 with findings.',
      '.claudin/memory/team/a.md: link [[mine]] reaches no memory its readers have',
      '.claudin/memory/team/lost.md: nothing links to it from its MEMORY.md — index it, or link it from a memory that is',
      '.claudin/memory/b.md: name "same" is shared with another memory in its directory',
    ])
  })

  test('--json carries the same findings and the same exit code', () => {
    const { output, exitCode } = formatMemoryAudit({ files: 3, findings: [secret] }, CWD, { json: true })
    expect(exitCode).toBe(1)
    expect(JSON.parse(output)).toEqual({
      files: 3,
      findings: [{ kind: 'secret', path: '.claudin/memory/team/bugs/x.md', labels: ['GitHub PAT'] }],
    })
  })

  test('memory off: nothing to audit, exit 0, in both formats', () => {
    expect(formatMemoryAudit(null, CWD).exitCode).toBe(0)
    expect(formatMemoryAudit(null, CWD).output).toContain('nothing to audit')
    expect(JSON.parse(formatMemoryAudit(null, CWD, { json: true }).output)).toEqual({ memory: 'off', files: 0, findings: [] })
  })
})
