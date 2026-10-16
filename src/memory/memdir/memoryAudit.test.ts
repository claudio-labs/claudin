import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  auditFails,
  auditMemoryDirs,
  findSecretShapedFiles,
  type MemoryFile,
  readMemoryFiles,
} from 'src/memory/memdir/memoryAudit.js'
import type { MemoryDir } from 'src/memory/memdir/memoryDirs.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

// Assembled at runtime, like teamMemSecretGuard.test.ts: no literal token in the tree.
const GITHUB_PAT = ['ghp', 'x'.repeat(36)].join('_')
const AWS_ACCESS_KEY = ['AKIA', 'Q'.repeat(16)].join('')

const file = (scope: MemoryFile['scope'], path: string, content: string): MemoryFile => ({ scope, path, content })

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
