/**
 * Unit tests for workspaceEdit.ts — pure normalization, application, and
 * rollback. Uses real temp files for the IO-bound path so we exercise the
 * actual FsOperations stack.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkspaceEdit } from 'vscode-languageserver-types'

import {
  LIMITS,
  applyNormalizedEdit,
  applyTextEditsToContent,
  pathsTouchedByEdit,
  resolveWorkspaceEdit,
} from './workspaceEdit.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wsedit-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function uri(p: string): string {
  return pathToFileURL(p).href
}

function fixturePath(name: string): string {
  return join(tmp, name)
}

function writeFixture(name: string, content: string): string {
  const p = fixturePath(name)
  writeFileSync(p, content)
  return p
}

// ---------------------------------------------------------------------------
// pathsTouchedByEdit
// ---------------------------------------------------------------------------

describe('pathsTouchedByEdit', () => {
  test('dedups paths from both changes and documentChanges', () => {
    const a = fixturePath('a.ts')
    const b = fixturePath('b.ts')
    const edit: WorkspaceEdit = {
      changes: {
        [uri(a)]: [],
        [uri(b)]: [],
      },
      documentChanges: [
        {
          textDocument: { uri: uri(a), version: 1 },
          edits: [],
        },
      ],
    }
    const paths = pathsTouchedByEdit(edit).sort()
    expect(paths).toEqual([a, b].sort())
  })

  test('includes both oldUri and newUri from rename ops', () => {
    const a = fixturePath('a.ts')
    const b = fixturePath('b.ts')
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'rename', oldUri: uri(a), newUri: uri(b) },
      ],
    }
    const paths = pathsTouchedByEdit(edit).sort()
    expect(paths).toEqual([a, b].sort())
  })

  test('skips non-file URIs', () => {
    const a = fixturePath('a.ts')
    const edit: WorkspaceEdit = {
      changes: {
        [uri(a)]: [],
        'untitled:Untitled-1': [],
      },
    }
    expect(pathsTouchedByEdit(edit)).toEqual([a])
  })
})

// ---------------------------------------------------------------------------
// resolveWorkspaceEdit
// ---------------------------------------------------------------------------

describe('resolveWorkspaceEdit', () => {
  test('flattens changes + documentChanges into per-path edit lists', () => {
    const a = fixturePath('a.ts')
    const edit: WorkspaceEdit = {
      changes: {
        [uri(a)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 3 },
            },
            newText: 'foo',
          },
        ],
      },
      documentChanges: [
        {
          textDocument: { uri: uri(a), version: 1 },
          edits: [
            {
              range: {
                start: { line: 5, character: 0 },
                end: { line: 5, character: 3 },
              },
              newText: 'bar',
            },
          ],
        },
      ],
    }
    const result = resolveWorkspaceEdit(edit)
    expect(result.ops).toHaveLength(1)
    const op = result.ops[0]
    if (op?.kind !== 'edit') throw new Error('expected edit op')
    expect(op.path).toBe(a)
    expect(op.edits).toHaveLength(2)
    // Reverse-sorted by start
    expect(op.edits[0]!.startLine).toBe(5)
    expect(op.edits[1]!.startLine).toBe(0)
  })

  test('detects overlapping edits and throws', () => {
    const a = fixturePath('a.ts')
    const edit: WorkspaceEdit = {
      changes: {
        [uri(a)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 10 },
            },
            newText: 'x',
          },
          {
            range: {
              start: { line: 0, character: 5 },
              end: { line: 0, character: 15 },
            },
            newText: 'y',
          },
        ],
      },
    }
    expect(() => resolveWorkspaceEdit(edit)).toThrow(/Overlapping edits/)
  })

  test('flags create/delete file ops as unsupported', () => {
    const a = fixturePath('a.ts')
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'create', uri: uri(a) },
        { kind: 'delete', uri: uri(a) },
      ],
    }
    const result = resolveWorkspaceEdit(edit)
    expect(result.hasUnsupported).toBe(true)
    expect(result.unsupportedReasons.some(r => r.includes('create'))).toBe(true)
    expect(result.unsupportedReasons.some(r => r.includes('delete'))).toBe(true)
  })

  test('preserves rename ops in output, after edits', () => {
    const a = fixturePath('a.ts')
    const b = fixturePath('b.ts')
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'rename', oldUri: uri(a), newUri: uri(b) },
        {
          textDocument: { uri: uri(a), version: 1 },
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 3 },
              },
              newText: 'X',
            },
          ],
        },
      ],
    }
    const result = resolveWorkspaceEdit(edit)
    const kinds = result.ops.map(o => o.kind)
    expect(kinds).toEqual(['edit', 'rename'])
  })
})

// ---------------------------------------------------------------------------
// applyTextEditsToContent — pure
// ---------------------------------------------------------------------------

describe('applyTextEditsToContent', () => {
  test('applies a single replace edit', () => {
    const content = 'foo bar baz\n'
    const result = applyTextEditsToContent(content, [
      {
        startLine: 0,
        startChar: 4,
        endLine: 0,
        endChar: 7,
        newText: 'BAR',
      },
    ])
    expect(result).toBe('foo BAR baz\n')
  })

  test('applies multiple edits in reverse order without shifting offsets', () => {
    const content = 'aaa\nbbb\nccc\n'
    // Two edits, reverse-sorted: line 2 then line 0
    const result = applyTextEditsToContent(content, [
      {
        startLine: 2,
        startChar: 0,
        endLine: 2,
        endChar: 3,
        newText: 'CCC',
      },
      {
        startLine: 0,
        startChar: 0,
        endLine: 0,
        endChar: 3,
        newText: 'AAA',
      },
    ])
    expect(result).toBe('AAA\nbbb\nCCC\n')
  })

  test('handles CRLF line endings', () => {
    const content = 'one\r\ntwo\r\nthree\r\n'
    const result = applyTextEditsToContent(content, [
      {
        startLine: 1,
        startChar: 0,
        endLine: 1,
        endChar: 3,
        newText: 'TWO',
      },
    ])
    expect(result).toBe('one\r\nTWO\r\nthree\r\n')
  })

  test('inserts at a position (zero-width range)', () => {
    const content = 'hello world\n'
    const result = applyTextEditsToContent(content, [
      {
        startLine: 0,
        startChar: 5,
        endLine: 0,
        endChar: 5,
        newText: ',',
      },
    ])
    expect(result).toBe('hello, world\n')
  })

  test('handles cross-line edits', () => {
    const content = 'line1\nline2\nline3\n'
    const result = applyTextEditsToContent(content, [
      {
        startLine: 0,
        startChar: 5,
        endLine: 1,
        endChar: 5,
        newText: '',
      },
    ])
    expect(result).toBe('line1\nline3\n')
  })

  test('returns content unchanged for empty edit list', () => {
    const content = 'abc'
    expect(applyTextEditsToContent(content, [])).toBe(content)
  })
})

// ---------------------------------------------------------------------------
// applyNormalizedEdit — IO with snapshot rollback
// ---------------------------------------------------------------------------

describe('applyNormalizedEdit', () => {
  test('writes edits to disk and reports modified paths', async () => {
    const a = writeFixture('a.ts', 'foo bar\n')
    const b = writeFixture('b.ts', 'baz qux\n')
    const edit: WorkspaceEdit = {
      changes: {
        [uri(a)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 3 },
            },
            newText: 'FOO',
          },
        ],
        [uri(b)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 3 },
            },
            newText: 'BAZ',
          },
        ],
      },
    }
    const normalized = resolveWorkspaceEdit(edit)
    const result = await applyNormalizedEdit(normalized, { write: true })

    expect(readFileSync(a, 'utf8')).toBe('FOO bar\n')
    expect(readFileSync(b, 'utf8')).toBe('BAZ qux\n')
    expect(result.modifiedPaths.sort()).toEqual([a, b].sort())
  })

  test('dry-run does not write but returns after-contents', async () => {
    const a = writeFixture('a.ts', 'hello\n')
    const edit: WorkspaceEdit = {
      changes: {
        [uri(a)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            newText: 'HELLO',
          },
        ],
      },
    }
    const normalized = resolveWorkspaceEdit(edit)
    const result = await applyNormalizedEdit(normalized, { write: false })
    expect(readFileSync(a, 'utf8')).toBe('hello\n')
    expect(result.afterContents.get(a)).toBe('HELLO\n')
  })

  test('two-phase apply allows dry-run preview before commit', async () => {
    const a = writeFixture('a.ts', 'original\n')
    const edit: WorkspaceEdit = {
      changes: {
        [uri(a)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 8 },
            },
            newText: 'changed',
          },
        ],
      },
    }
    const normalized = resolveWorkspaceEdit(edit)

    // Dry-run captures the after-content without touching disk
    const dryrun = await applyNormalizedEdit(normalized, { write: false })
    expect(dryrun.afterContents.get(a)).toBe('changed\n')
    expect(readFileSync(a, 'utf8')).toBe('original\n')

    // A subsequent real apply succeeds
    const result = await applyNormalizedEdit(normalized, { write: true })
    expect(result.modifiedPaths).toContain(a)
    expect(readFileSync(a, 'utf8')).toBe('changed\n')
  })

  test('detects content drift between snapshot and write', async () => {
    // Drift simulated by writing through a custom FsOperations override.
    // We swap getFsImplementation to return a wrapper that mutates the
    // second readFile (Phase 3 re-read) so its sha differs from Phase 1's.
    const a = writeFixture('drift.ts', 'original\n')
    const edit: WorkspaceEdit = {
      changes: {
        [uri(a)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 8 },
            },
            newText: 'changed',
          },
        ],
      },
    }

    const {
      getFsImplementation,
      setFsImplementation,
    } = await import('../../utils/fsOperations.js')
    const original = getFsImplementation()
    let readCount = 0
    setFsImplementation({
      ...original,
      async readFile(p, opts) {
        readCount++
        if (readCount === 2) {
          // Phase 3 re-read — return drifted content
          return 'DRIFTED!\n'
        }
        return original.readFile(p, opts)
      },
    })
    try {
      const normalized = resolveWorkspaceEdit(edit)
      await expect(
        applyNormalizedEdit(normalized, { write: true }),
      ).rejects.toThrow(/changed during LSP refactor/)
      // File on disk is untouched
      expect(readFileSync(a, 'utf8')).toBe('original\n')
    } finally {
      setFsImplementation(original)
    }
  })

  test('rolls back already-written files when a later write fails', async () => {
    const a = writeFixture('a.ts', 'AAA\n')
    const b = writeFixture('b.ts', 'BBB\n')
    const edit: WorkspaceEdit = {
      // Map iteration is insertion order — a goes first
      changes: {
        [uri(a)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 3 },
            },
            newText: 'xxx',
          },
        ],
        [uri(b)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 3 },
            },
            newText: 'yyy',
          },
        ],
      },
    }

    const {
      getFsImplementation,
      setFsImplementation,
    } = await import('../../utils/fsOperations.js')
    const original = getFsImplementation()
    let bReadCount = 0
    setFsImplementation({
      ...original,
      async readFile(p, opts) {
        if (p === b) {
          bReadCount++
          if (bReadCount === 2) return 'DRIFTED\n' // trigger drift on b's Phase 3
        }
        return original.readFile(p, opts)
      },
    })
    try {
      const normalized = resolveWorkspaceEdit(edit)
      await expect(
        applyNormalizedEdit(normalized, { write: true }),
      ).rejects.toThrow(/changed during LSP refactor/)
      // a was written, then rolled back
      expect(readFileSync(a, 'utf8')).toBe('AAA\n')
      // b untouched
      expect(readFileSync(b, 'utf8')).toBe('BBB\n')
    } finally {
      setFsImplementation(original)
    }
  })

  test('renames a file', async () => {
    const a = writeFixture('a.ts', 'hello\n')
    const b = join(tmp, 'b.ts')
    const edit: WorkspaceEdit = {
      documentChanges: [
        { kind: 'rename', oldUri: uri(a), newUri: uri(b) },
      ],
    }
    const normalized = resolveWorkspaceEdit(edit)
    const result = await applyNormalizedEdit(normalized, { write: true })

    expect(result.renamedPaths).toEqual([{ oldPath: a, newPath: b }])
    expect(() => statSync(a)).toThrow()
    expect(readFileSync(b, 'utf8')).toBe('hello\n')
  })

  test('EXDEV rename falls back to copy+unlink without corrupting bytes', async () => {
    // Simulate cross-device rename by making fs.rename throw EXDEV; verify
    // the fallback moves raw bytes (no utf8 round-trip) and old path is gone.
    const a = writeFixture('binary.bin', '')
    // Write non-utf8 bytes that would be corrupted by readFile('utf8').
    const rawBytes = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x00, 0x42])
    writeFileSync(a, rawBytes)
    const b = join(tmp, 'binary-renamed.bin')

    const {
      getFsImplementation,
      setFsImplementation,
    } = await import('../../utils/fsOperations.js')
    const original = getFsImplementation()
    setFsImplementation({
      ...original,
      async rename(_oldPath, _newPath) {
        const err = new Error('EXDEV') as NodeJS.ErrnoException
        err.code = 'EXDEV'
        throw err
      },
    })
    try {
      const edit: WorkspaceEdit = {
        documentChanges: [{ kind: 'rename', oldUri: uri(a), newUri: uri(b) }],
      }
      const normalized = resolveWorkspaceEdit(edit)
      const result = await applyNormalizedEdit(normalized, { write: true })

      expect(result.renamedPaths).toEqual([{ oldPath: a, newPath: b }])
      expect(() => statSync(a)).toThrow()
      // Bytes must match exactly — corrupted utf8 round-trip would change them.
      const after = readFileSync(b)
      expect(after.equals(rawBytes)).toBe(true)
    } finally {
      setFsImplementation(original)
    }
  })

  test('refuses to apply when over maxFiles', async () => {
    // Build a normalized edit synthetically with > LIMITS.maxFiles edit ops
    const ops = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({
      kind: 'edit' as const,
      path: join(tmp, `f${i}.ts`),
      edits: [],
    }))
    await expect(
      applyNormalizedEdit(
        { ops, hasUnsupported: false, unsupportedReasons: [] },
        { write: true },
      ),
    ).rejects.toThrow(/max is /)
  })
})
