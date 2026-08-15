import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateGlobalMemoryIfNeeded } from 'src/memory/memdir/memoryMigration.js'

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('migrateGlobalMemoryIfNeeded', () => {
  test('copies MEMORY.md and topic files from the old dir into an empty new dir', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = join(freshDir('claudin-migrate-new-'), 'nested')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- a memory\n')
    writeFileSync(join(oldDir, 'topic.md'), '# topic\n')

    migrateGlobalMemoryIfNeeded(oldDir, newDir)

    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- a memory\n',
    )
    expect(readFileSync(join(newDir, 'topic.md'), 'utf-8')).toBe('# topic\n')
  })

  test('copies the team/ subfolder too', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = join(freshDir('claudin-migrate-new-'), 'nested')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- a memory\n')
    mkdirSync(join(oldDir, 'team'))
    writeFileSync(join(oldDir, 'team', 'MEMORY.md'), '- team memory\n')

    migrateGlobalMemoryIfNeeded(oldDir, newDir)

    expect(readFileSync(join(newDir, 'team', 'MEMORY.md'), 'utf-8')).toBe(
      '- team memory\n',
    )
  })

  test('is a no-op when the new dir already has memory content', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = freshDir('claudin-migrate-new-')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- old\n')
    writeFileSync(join(newDir, 'MEMORY.md'), '- already here\n')

    migrateGlobalMemoryIfNeeded(oldDir, newDir)

    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- already here\n',
    )
  })

  test('is a no-op when the old dir has no memory content', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = join(freshDir('claudin-migrate-new-'), 'nested')

    migrateGlobalMemoryIfNeeded(oldDir, newDir)

    expect(existsSync(newDir)).toBe(false)
  })

  test('never deletes or mutates the old dir', () => {
    const oldDir = freshDir('claudin-migrate-old-')
    const newDir = join(freshDir('claudin-migrate-new-'), 'nested')
    writeFileSync(join(oldDir, 'MEMORY.md'), '- a memory\n')

    migrateGlobalMemoryIfNeeded(oldDir, newDir)

    expect(existsSync(oldDir)).toBe(true)
    expect(readFileSync(join(oldDir, 'MEMORY.md'), 'utf-8')).toBe(
      '- a memory\n',
    )
  })

  test('is a no-op when oldDir and newDir are the same path', () => {
    const dir = freshDir('claudin-migrate-same-')
    writeFileSync(join(dir, 'MEMORY.md'), '- a memory\n')

    expect(() => migrateGlobalMemoryIfNeeded(dir, dir)).not.toThrow()
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe('- a memory\n')
  })
})
