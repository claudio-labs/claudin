import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileCursorStore, memoryCursorStore } from 'src/memory/extract/extractionCursor.js'

describe('fileCursorStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'extraction-cursor-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('keeps one cursor per session beside the transcripts, the last write winning', () => {
    const store = fileCursorStore(() => join(root, 'project'))
    expect(store.read('s1')).toBeUndefined()
    store.write('s1', 'uuid-1')
    store.write('s1', 'uuid-2')
    store.write('s2', 'uuid-9')
    expect(store.read('s1')).toBe('uuid-2')
    expect(store.read('s2')).toBe('uuid-9')
    expect(readFileSync(join(root, 'project', 's1.memory-cursor'), 'utf8')).toBe('uuid-2\n')
  })

  test('an empty file reads as no cursor, and a dir that cannot hold one never throws', () => {
    const store = fileCursorStore(() => join(root, 'project'))
    writeFileSync(join(root, 'project', 's3.memory-cursor'), '\n')
    expect(store.read('s3')).toBeUndefined()
    writeFileSync(join(root, 'blocked'), 'a file')
    const blocked = fileCursorStore(() => join(root, 'blocked'))
    expect(() => blocked.write('s1', 'uuid')).not.toThrow()
    expect(blocked.read('s1')).toBeUndefined()
  })
})

describe('memoryCursorStore', () => {
  test('keeps cursors for the life of the store', () => {
    const store = memoryCursorStore()
    store.write('s1', 'u')
    expect(store.read('s1')).toBe('u')
    expect(store.read('s2')).toBeUndefined()
  })
})
