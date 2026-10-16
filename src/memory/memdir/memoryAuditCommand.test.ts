import { describe, expect, test } from 'bun:test'
import { formatMemoryAudit } from 'src/memory/memdir/memoryAuditCommand.js'

const CWD = '/repo'
const secret = { kind: 'secret' as const, path: '/repo/.claudin/memory/team/bugs/x.md', labels: ['GitHub PAT'] }

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
