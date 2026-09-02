import { expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  copyFileIfAbsent,
  copyTreeWithoutOverwriting,
  countTopLevelEntries,
  listFilesRecursive,
  readJson,
} from 'src/platform/import/writers/files.js'
import { mergeJsonFileNonDestructive } from 'src/platform/import/writers/settings.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'claudin-import-writers-'))
}

test('copyFileIfAbsent writes once and never clobbers', () => {
  const dir = tempDir()
  const src = join(dir, 'CLAUDE.md')
  const dst = join(dir, 'out', 'CLAUDE.md')
  writeFileSync(src, 'from claude', 'utf8')

  expect(copyFileIfAbsent(src, dst)).toBe(true)
  expect(readFileSync(dst, 'utf8')).toBe('from claude')

  writeFileSync(src, 'changed upstream', 'utf8')
  expect(copyFileIfAbsent(src, dst)).toBe(false)
  expect(readFileSync(dst, 'utf8')).toBe('from claude')
})

test('copyFileIfAbsent reports a missing source rather than throwing', () => {
  const dir = tempDir()
  expect(copyFileIfAbsent(join(dir, 'absent.md'), join(dir, 'out.md'))).toBe(
    false,
  )
})

test('copyTreeWithoutOverwriting keeps destination files that already exist', () => {
  const dir = tempDir()
  const src = join(dir, 'commands')
  const dst = join(dir, 'dest-commands')
  mkdirSync(src, { recursive: true })
  mkdirSync(dst, { recursive: true })
  writeFileSync(join(src, 'a.md'), 'source a', 'utf8')
  writeFileSync(join(src, 'b.md'), 'source b', 'utf8')
  writeFileSync(join(dst, 'a.md'), 'mine', 'utf8')

  expect(copyTreeWithoutOverwriting(src, dst)).toBe(true)
  expect(readFileSync(join(dst, 'a.md'), 'utf8')).toBe('mine')
  expect(readFileSync(join(dst, 'b.md'), 'utf8')).toBe('source b')
  expect(countTopLevelEntries(dst)).toBe(2)
})

test('copyTreeWithoutOverwriting refuses a source that is a file', () => {
  const dir = tempDir()
  const src = join(dir, 'notadir')
  writeFileSync(src, 'x', 'utf8')
  expect(copyTreeWithoutOverwriting(src, join(dir, 'dest'))).toBe(false)
})

test('copyTreeWithoutOverwriting resolves a symlinked source into real files', () => {
  const dir = tempDir()
  const real = join(dir, 'shared', 'omarchy')
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'SKILL.md'), 'shared skill', 'utf8')

  const linked = join(dir, 'skills', 'omarchy')
  mkdirSync(join(dir, 'skills'), { recursive: true })
  symlinkSync(real, linked)

  const dst = join(dir, 'dest', 'omarchy')
  expect(copyTreeWithoutOverwriting(linked, dst)).toBe(true)
  expect(lstatSync(dst).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(dst, 'SKILL.md'), 'utf8')).toBe('shared skill')
})

test('copyTreeWithoutOverwriting resolves a symlinked file inside the tree', () => {
  const dir = tempDir()
  const target = join(dir, 'target.md')
  writeFileSync(target, 'linked body', 'utf8')
  const src = join(dir, 'skill')
  mkdirSync(src, { recursive: true })
  symlinkSync(target, join(src, 'SKILL.md'))

  const dst = join(dir, 'dest')
  expect(copyTreeWithoutOverwriting(src, dst)).toBe(true)
  expect(lstatSync(join(dst, 'SKILL.md')).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(dst, 'SKILL.md'), 'utf8')).toBe('linked body')
})

test('listFilesRecursive keeps the foreign tool namespacing in the path', () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'git'), { recursive: true })
  writeFileSync(join(dir, 'review.toml'), '', 'utf8')
  writeFileSync(join(dir, 'git', 'commit.toml'), '', 'utf8')
  writeFileSync(join(dir, 'notes.txt'), '', 'utf8')

  expect(listFilesRecursive(dir, ['.toml'])).toEqual([
    'git/commit.toml',
    'review.toml',
  ])
})

test('listFilesRecursive returns nothing for a directory that is not there', () => {
  expect(listFilesRecursive(join(tempDir(), 'absent'), ['.md'])).toEqual([])
})

test('mergeJsonFileNonDestructive lets the existing value win', () => {
  const dir = tempDir()
  const src = join(dir, 'src.json')
  const dst = join(dir, 'dst.json')
  writeFileSync(src, JSON.stringify({ theme: 'dark', model: 'a' }), 'utf8')
  writeFileSync(dst, JSON.stringify({ theme: 'light' }), 'utf8')

  const result = mergeJsonFileNonDestructive(src, dst)
  expect(result).toEqual({ outcome: 'merged', copiedKeys: 1 })
  expect(readJson(dst)).toEqual({ theme: 'light', model: 'a' })
})

test('mergeJsonFileNonDestructive honors the key whitelist', () => {
  const dir = tempDir()
  const src = join(dir, 'src.json')
  const dst = join(dir, 'dst.json')
  writeFileSync(src, JSON.stringify({ theme: 'dark', secret: 'x' }), 'utf8')

  const result = mergeJsonFileNonDestructive(src, dst, { keys: ['theme'] })
  expect(result).toEqual({ outcome: 'merged', copiedKeys: 1 })
  expect(readJson(dst)).toEqual({ theme: 'dark' })
})

test('mergeJsonFileNonDestructive does not rewrite a destination it adds nothing to', () => {
  const dir = tempDir()
  const src = join(dir, 'src.json')
  const dst = join(dir, 'dst.json')
  writeFileSync(src, JSON.stringify({ theme: 'dark' }), 'utf8')
  writeFileSync(dst, '{"theme":"light"}', 'utf8')

  expect(mergeJsonFileNonDestructive(src, dst)).toEqual({
    outcome: 'merged',
    copiedKeys: 0,
  })
  // byte-for-byte untouched, not reserialized
  expect(readFileSync(dst, 'utf8')).toBe('{"theme":"light"}')
})

test('mergeJsonFileNonDestructive distinguishes a missing source from a broken one', () => {
  const dir = tempDir()
  const dst = join(dir, 'dst.json')
  expect(mergeJsonFileNonDestructive(join(dir, 'absent.json'), dst)).toEqual({
    outcome: 'noSource',
    copiedKeys: 0,
  })

  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{not json', 'utf8')
  expect(mergeJsonFileNonDestructive(broken, dst)).toEqual({
    outcome: 'unparseableSource',
    copiedKeys: 0,
  })
})
