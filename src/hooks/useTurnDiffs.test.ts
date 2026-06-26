import type { StructuredPatchHunk } from 'diff'
import { describe, expect, test } from 'bun:test'
import type { TurnDiff } from './useTurnDiffs.js'
import {
  applyToolResultToTurn,
  isApplyPatchResult,
  mergeFileDiff,
} from './useTurnDiffs.js'

const hunk = (lines: string[]): StructuredPatchHunk => ({
  oldStart: 1,
  oldLines: lines.filter(l => l.startsWith('-') || l.startsWith(' ')).length,
  newStart: 1,
  newLines: lines.filter(l => l.startsWith('+') || l.startsWith(' ')).length,
  lines,
})

const emptyTurn = (): TurnDiff => ({
  turnIndex: 1,
  userPromptPreview: '',
  timestamp: '',
  files: new Map(),
  stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
})

describe('isApplyPatchResult', () => {
  test('matches the apply_patch { files: [...] } shape', () => {
    expect(
      isApplyPatchResult({
        files: [
          { absPath: '/a', type: 'add', additions: 1, deletions: 0, structuredPatch: [] },
        ],
      }),
    ).toBe(true)
    // An empty patch result still matches (no files to fan out).
    expect(isApplyPatchResult({ files: [] })).toBe(true)
  })

  test('rejects FileEdit/FileWrite-shaped and junk results', () => {
    // FileEdit/FileWrite results carry a top-level filePath, not `files`.
    expect(isApplyPatchResult({ filePath: '/a', structuredPatch: [] })).toBe(false)
    expect(isApplyPatchResult({ files: [{ absPath: '/a' }] })).toBe(false) // no structuredPatch
    expect(isApplyPatchResult(null)).toBe(false)
    expect(isApplyPatchResult('x')).toBe(false)
  })
})

describe('mergeFileDiff', () => {
  test('fans out add/update/move into per-file turn entries', () => {
    const turn = emptyTurn()
    mergeFileDiff(turn, '/a.ts', [hunk(['+one', '+two'])], true)
    mergeFileDiff(turn, '/b.ts', [hunk([' ctx', '-old', '+new'])], false)
    // A move keys on the destination path.
    mergeFileDiff(turn, '/dest.ts', [hunk(['+moved'])], false)

    expect([...turn.files.keys()].sort()).toEqual(['/a.ts', '/b.ts', '/dest.ts'])
    const a = turn.files.get('/a.ts')!
    expect(a.isNewFile).toBe(true)
    expect(a.linesAdded).toBe(2)
    expect(a.linesRemoved).toBe(0)
    const b = turn.files.get('/b.ts')!
    expect(b.isNewFile).toBe(false)
    expect(b.linesAdded).toBe(1)
    expect(b.linesRemoved).toBe(1)
  })

  test('accumulates when the same path is touched twice in a turn', () => {
    const turn = emptyTurn()
    mergeFileDiff(turn, '/a.ts', [hunk(['+one'])], true)
    mergeFileDiff(turn, '/a.ts', [hunk(['+two'])], false)
    const a = turn.files.get('/a.ts')!
    expect(a.linesAdded).toBe(2)
    expect(a.hunks).toHaveLength(2)
    // Still flagged as a new file from the first merge.
    expect(a.isNewFile).toBe(true)
  })
})

describe('applyToolResultToTurn (dispatch + wiring)', () => {
  test('routes an apply_patch { files: [...] } result, keying a move on its dest', () => {
    const turn = emptyTurn()
    applyToolResultToTurn(turn, {
      files: [
        { absPath: '/new.ts', type: 'add', additions: 1, deletions: 0, structuredPatch: [hunk(['+x'])] },
        { absPath: '/edit.ts', type: 'update', additions: 1, deletions: 1, structuredPatch: [hunk([' c', '-old', '+new'])] },
        { absPath: '/old.ts', type: 'move', movePath: '/dest.ts', additions: 1, deletions: 0, structuredPatch: [hunk(['+m'])] },
      ],
    })
    // The move is keyed on /dest.ts, NOT the source /old.ts.
    expect([...turn.files.keys()].sort()).toEqual(['/dest.ts', '/edit.ts', '/new.ts'])
    expect(turn.files.has('/old.ts')).toBe(false)
    expect(turn.files.get('/new.ts')!.isNewFile).toBe(true)
    expect(turn.files.get('/edit.ts')!.isNewFile).toBe(false)
  })

  test('routes a FileEdit result via its top-level filePath', () => {
    const turn = emptyTurn()
    applyToolResultToTurn(turn, {
      filePath: '/a.ts',
      structuredPatch: [hunk([' c', '-old', '+new'])],
    })
    expect(turn.files.get('/a.ts')!.linesAdded).toBe(1)
    expect(turn.files.get('/a.ts')!.linesRemoved).toBe(1)
  })

  test('ignores results that are neither FileEdit nor apply_patch', () => {
    const turn = emptyTurn()
    applyToolResultToTurn(turn, { stdout: 'hello' })
    expect(turn.files.size).toBe(0)
  })
})
