import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateLegacyMemoryIfNeeded } from 'src/memory/memdir/memoryMigration.js'

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('migrateLegacyMemoryIfNeeded', () => {
  test('copies MEMORY.md and topic files from the old dir into an empty new dir', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = join(freshDir('claudin-migrate-new-'), 'nested')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- a memory\n')
    writeFileSync(join(oldDir, 'topic.md'), '# topic\n')

    migrateLegacyMemoryIfNeeded(oldDir, newDir)

    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- a memory\n',
    )
    expect(readFileSync(join(newDir, 'topic.md'), 'utf-8')).toBe('# topic\n')
  })

  test('is a no-op when the new dir already has memory content', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = freshDir('claudin-migrate-new-')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- old\n')
    writeFileSync(join(newDir, 'MEMORY.md'), '- already here\n')

    migrateLegacyMemoryIfNeeded(oldDir, newDir)

    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- already here\n',
    )
  })

  test('is a no-op when the old dir has no memory content', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = join(freshDir('claudin-migrate-new-'), 'nested')

    migrateLegacyMemoryIfNeeded(oldDir, newDir)

    expect(existsSync(newDir)).toBe(false)
  })

  test('never deletes or mutates the old dir', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = join(freshDir('claudin-migrate-new-'), 'nested')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- a memory\n')

    migrateLegacyMemoryIfNeeded(oldDir, newDir)

    expect(existsSync(oldDir)).toBe(true)
    expect(readFileSync(join(oldDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- a memory\n',
    )
  })

  // team/bugs/legacy-memory-migration-resurrects-team-files: the private dir
  // looked empty, so the legacy copy wrote its June team/ back — the files
  // since moved, renamed or deleted landed untracked in the git-tracked dir.
  test('never copies the legacy team/ into the git-tracked team dir', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = freshDir('claudin-migrate-new-')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- a memory\n')
    mkdirSync(join(oldDir, 'team'))
    writeFileSync(join(oldDir, 'team', 'moved-since.md'), '# stale\n')
    mkdirSync(join(newDir, 'team'))
    writeFileSync(join(newDir, 'team', 'live.md'), '# tracked\n')

    migrateLegacyMemoryIfNeeded(oldDir, newDir)

    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8')).toBe('- a memory\n')
    expect(existsSync(join(newDir, 'team', 'moved-since.md'))).toBe(false)
  })

  test('migrates once: a private dir emptied later is not refilled from the legacy one', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = freshDir('claudin-migrate-new-')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- june snapshot\n')
    migrateLegacyMemoryIfNeeded(oldDir, newDir)
    rmSync(join(newDir, 'MEMORY.md'))

    migrateLegacyMemoryIfNeeded(oldDir, newDir)

    expect(existsSync(join(newDir, 'MEMORY.md'))).toBe(false)
  })

  test('is a no-op when oldDir and newDir are the same path', () => {
    const dir = freshDir('claudin-migrate-same-')
    writeFileSync(join(dir, 'MEMORY.md'), '- a memory\n')

    expect(() => migrateLegacyMemoryIfNeeded(dir, dir)).not.toThrow()
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe('- a memory\n')
  })
})
