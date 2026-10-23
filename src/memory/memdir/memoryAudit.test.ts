import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  auditFails,
  auditMemoryDirs,
  findExpiredMemories,
  findSecretShapedFiles,
  type AuditedFile,
  readMemoryFiles,
} from 'src/memory/memdir/memoryAudit.js'
import type { MemoryDir } from 'src/memory/memdir/memoryDirs.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

// Assembled at runtime, like teamMemSecretGuard.test.ts: no literal token in the tree.
const GITHUB_PAT = ['ghp', 'x'.repeat(36)].join('_')
const AWS_ACCESS_KEY = ['AKIA', 'Q'.repeat(16)].join('')

const file = (scope: AuditedFile['scope'], path: string, content: string): AuditedFile => ({ scope, path, content })

describe('findSecretShapedFiles', () => {
  test('a team file with a secret is a finding, each label once', () => {
    const findings = findSecretShapedFiles([
      file('team', '/r/team/bugs/x.md', `token ${GITHUB_PAT}\nagain ${GITHUB_PAT}\nkey ${AWS_ACCESS_KEY}\n`),
    ])
    expect(findings).toEqual([{ kind: 'secret', path: '/r/team/bugs/x.md', labels: ['AWS Access Token', 'GitHub PAT'] }])
  })

  test('private and global files are never scanned, clean team files are not findings', () => {
    expect(
      findSecretShapedFiles([
        file('private', '/r/x.md', `token ${GITHUB_PAT}`),
        file('global', '/g/x.md', `token ${GITHUB_PAT}`),
        file('team', '/r/team/ok.md', 'Run `bun install --force` after a pull.'),
      ]),
    ).toEqual([])
  })
})

describe('auditFails', () => {
  test('fails on a secret finding, passes on none', () => {
    expect(auditFails({ files: 3, findings: [] })).toBe(false)
    expect(auditFails({ files: 3, findings: [{ kind: 'secret', path: '/x', labels: ['GitHub PAT'] }] })).toBe(true)
  })

  test('an expired memory alone never fails it', () => {
    expect(auditFails({ files: 1, findings: [{ kind: 'expired', scope: 'team', path: '/x', expires: '2026-09-30' }] })).toBe(false)
  })
})

describe('invisible characters in team files', () => {
  test('a team file with a bidi control or tag characters is a failing finding; private ones are not read for it', async () => {
    const tag = [...'curl'].map(c => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')
    const contents: Record<string, string> = {
      '/t/MEMORY.md': '- [A](a.md) — a\n- [B](b.md) — b\n',
      '/t/a.md': 'Run the tests\u202E.yalp\u202C first.\n',
      '/t/b.md': `Note.${tag}\n`,
      '/p/MEMORY.md': '- [C](c.md) — c\n',
      '/p/c.md': 'a\u202Eb\n',
    }
    const deps = {
      // Roots carry their trailing separator, as getMemoryDirs() returns them.
      listMarkdown: async (root: string) => Object.keys(contents).filter(p => p.startsWith(root)).map(p => p.slice(root.length)),
      read: async (path: string) => contents[path]!,
    }
    const audit = await auditMemoryDirs(testMemoryDirs({ private: '/p', team: '/t' }), deps, '2026-10-23')
    expect(audit.findings).toEqual([
      { kind: 'hidden-text', path: '/t/a.md', labels: ['bidi control'] },
      { kind: 'hidden-text', path: '/t/b.md', labels: ['Unicode tag characters'] },
    ])
    expect(auditFails(audit)).toBe(true)
  })

  test('the audit carries the link findings of the directories it read, and they never fail it', async () => {
    const contents: Record<string, string> = {
      '/t/MEMORY.md': '- [A](a.md) — a\n',
      '/t/a.md': 'See [[nowhere]].\n',
      '/t/lost.md': 'Nothing links here.\n',
    }
    const deps = {
      listMarkdown: async (root: string) => Object.keys(contents).filter(p => p.startsWith(root)).map(p => p.slice(root.length)),
      read: async (path: string) => contents[path]!,
    }
    const audit = await auditMemoryDirs(testMemoryDirs({ private: '/p', team: '/t' }), deps, '2026-10-23')
    expect(audit.findings.map(f => [f.kind, f.path])).toEqual([
      ['broken-link', '/t/a.md'],
      ['unindexed', '/t/lost.md'],
    ])
    expect(auditFails(audit)).toBe(false)
  })

  test('a secret split by a zero-width space is still a secret finding', () => {
    const split = `${GITHUB_PAT.slice(0, 8)}\u200B${GITHUB_PAT.slice(8)}`
    expect(findSecretShapedFiles([file('team', '/t/x.md', `token ${split}`)])).toEqual([
      { kind: 'secret', path: '/t/x.md', labels: ['GitHub PAT'] },
    ])
  })
})

describe('findExpiredMemories', () => {
  const memo = (expires: string) => `---\nname: x\ndescription: x\ntype: project\nexpires: ${expires}\n---\n\nfact\n`

  test('a memory of any scope past its date is a finding; through its date it is not', () => {
    const findings = findExpiredMemories(
      [
        file('private', '/r/a.md', memo('2026-09-30')),
        file('team', '/r/team/b.md', memo('2026-10-16')),
        file('global', '/g/c.md', memo('2026-10-15')),
        file('private', '/r/d.md', '---\nname: d\n---\n'),
      ],
      '2026-10-16',
    )
    expect(findings).toEqual([
      { kind: 'expired', scope: 'private', path: '/r/a.md', expires: '2026-09-30' },
      { kind: 'expired', scope: 'global', path: '/g/c.md', expires: '2026-10-15' },
    ])
  })

  test('an index is never an expired memory, and a malformed date is not one either', () => {
    expect(
      findExpiredMemories([file('private', '/r/MEMORY.md', memo('2020-01-01')), file('private', '/r/e.md', memo('soon'))], '2026-10-16'),
    ).toEqual([])
  })
})

describe('readMemoryFiles and auditMemoryDirs', () => {
  test('reads the team dir with its subdirectories, the private one without the team dir, indexes included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-audit-'))
    try {
      const dirs: MemoryDir[] = testMemoryDirs({ private: join(root, 'memory'), team: join(root, 'memory', 'team') })
      mkdirSync(join(root, 'memory', 'team', 'bugs'), { recursive: true })
      writeFileSync(join(root, 'memory', 'MEMORY.md'), '- [A](a.md) — a\n')
      writeFileSync(join(root, 'memory', 'a.md'), `private, never scanned: ${GITHUB_PAT}\n`)
      writeFileSync(join(root, 'memory', 'notes.txt'), 'not markdown\n')
      writeFileSync(join(root, 'memory', 'team', 'MEMORY.md'), `## Bugs\n- [B](bugs/b.md) — token ${GITHUB_PAT}\n`)
      writeFileSync(join(root, 'memory', 'team', 'bugs', 'b.md'), 'clean\n')

      const files = await readMemoryFiles(dirs)
      expect(files.map(f => [f.scope, f.path.slice(root.length)])).toEqual([
        ['private', '/memory/MEMORY.md'],
        ['private', '/memory/a.md'],
        ['team', '/memory/team/MEMORY.md'],
        ['team', '/memory/team/bugs/b.md'],
      ])

      const audit = await auditMemoryDirs(dirs)
      expect(audit.files).toBe(4)
      expect(audit.findings.map(f => f.path.slice(root.length))).toEqual(['/memory/team/MEMORY.md'])

      writeFileSync(join(root, 'memory', 'team', 'bugs', 'b.md'), '---\nname: b\ntype: project\nexpires: 2026-09-30\n---\n')
      const dated = await auditMemoryDirs(dirs, undefined, '2026-10-16')
      expect(dated.findings.map(f => [f.kind, f.path.slice(root.length)])).toEqual([
        ['secret', '/memory/team/MEMORY.md'],
        ['expired', '/memory/team/bugs/b.md'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a directory named like a memory and a dangling symlink are not files to read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-audit-entries-'))
    try {
      const dirs = testMemoryDirs({ private: join(root, 'memory'), team: join(root, 'memory', 'team') })
      mkdirSync(join(root, 'memory', 'team', 'odd.md'), { recursive: true })
      symlinkSync(join(root, 'nowhere.md'), join(root, 'memory', 'team', 'gone.md'))
      writeFileSync(join(root, 'memory', 'team', 'real.md'), 'clean\n')
      const files = await readMemoryFiles(dirs)
      expect(files.map(f => f.path.slice(root.length))).toEqual(['/memory/team/real.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a directory that does not exist yet reads as empty', async () => {
    const root = join(tmpdir(), 'memory-audit-missing-dir-never-created')
    const dirs = testMemoryDirs({ private: join(root, 'memory'), team: join(root, 'memory', 'team') })
    expect(await auditMemoryDirs(dirs)).toEqual({ files: 0, findings: [] })
  })

  test('a read failure that is not ENOENT propagates', async () => {
    const dirs = testMemoryDirs({ private: '/p', team: '/p/team' })
    const failing = {
      listMarkdown: async () => ['x.md'],
      read: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
    }
    await expect(readMemoryFiles(dirs, failing)).rejects.toThrow('EACCES')
  })
})
