import { readFileSync } from 'fs'
import { describe, expect, test } from 'bun:test'
import type { FileState } from 'src/utils/fs/fileStateCache.js'
import {
  FILE_CLIPPED_VIEW_ERROR,
  FILE_NOT_READ_ERROR,
  FILE_PARTIAL_VIEW_ERROR,
  isWholeFileView,
  needsWholeFileRead,
  readGateMessage,
  readGateReasonFor,
  satisfiesReadGate,
  seenRangeLabel,
  seenRegionCovers,
  unseenRegionMessage,
  wholeFileRequiredMessage,
  writeFamilyReadGateError,
} from './readBeforeEditMessages.js'

function state(over: Partial<FileState> = {}): FileState {
  return {
    content: 'x',
    timestamp: 1,
    offset: undefined,
    limit: undefined,
    ...over,
  } as FileState
}

const CLIPPED = state({
  isPartialView: true,
  standDownOutline: {
    message: '<outline>',
    servedOutline: true,
    epoch: 0,
    replays: 0,
  },
} as Partial<FileState>)

describe('satisfiesReadGate', () => {
  test('a full read passes', () => {
    expect(satisfiesReadGate(state())).toBe(true)
  })

  test('a missing entry fails', () => {
    expect(satisfiesReadGate(undefined)).toBe(false)
  })

  test('a partial view fails even though an entry exists', () => {
    // This is the four-tool invariant in .claudin/rules/cache.md: presence has
    // never meant "the model saw these bytes".
    expect(satisfiesReadGate(state({ isPartialView: true }))).toBe(false)
  })

  test('a clipped entry fails', () => {
    expect(satisfiesReadGate(CLIPPED)).toBe(false)
  })
})

describe('readGateReasonFor', () => {
  test('distinguishes the three failure causes', () => {
    expect(readGateReasonFor(undefined)).toBe('never-read')
    expect(readGateReasonFor(state({ isPartialView: true }))).toBe(
      'partial-view',
    )
    expect(readGateReasonFor(CLIPPED)).toBe('clipped')
  })
})

describe('readGateMessage', () => {
  test('never-read does not claim a partial view', () => {
    const m = readGateMessage('never-read', 'src/a.ts', 'patching it')
    expect(m).toBe(
      'src/a.ts has not been read yet. Read it first before patching it.',
    )
  })

  test('partial-view names view=full and does not claim the file was unread', () => {
    const m = readGateMessage('partial-view', 'src/a.ts', 'patching it')
    expect(m).toContain("view='full'")
    expect(m).not.toContain('has not been read yet')
  })

  test('clipped also names view=full', () => {
    // The remedy is NOT "just read it again": the sticky clip-pin marker
    // replays the same outline for STICKY_REPLAY_BUDGET reads
    // (FileReadTool.ts:456 guards on `view === undefined`), so a plain re-Read
    // loops. An earlier version of this message advised exactly that.
    const m = readGateMessage('clipped', 'src/a.ts', 'patching it')
    expect(m).toContain("view='full'")
    expect(m).toContain('clipped out of the transcript')
  })

  test('every reason threads the caller subject and action', () => {
    for (const reason of ['never-read', 'partial-view', 'clipped'] as const) {
      const m = readGateMessage(reason, 'SUBJ', 'ACTING')
      expect(m.startsWith('SUBJ')).toBe(true)
      expect(m).toContain('ACTING')
    }
  })
})

describe('writeFamilyReadGateError', () => {
  test('maps each cause to a distinct constant', () => {
    expect(writeFamilyReadGateError(undefined)).toBe(FILE_NOT_READ_ERROR)
    expect(writeFamilyReadGateError(state({ isPartialView: true }))).toBe(
      FILE_PARTIAL_VIEW_ERROR,
    )
    expect(writeFamilyReadGateError(CLIPPED)).toBe(FILE_CLIPPED_VIEW_ERROR)
  })

  test('the three constants are mutually non-substring', () => {
    // FileEditTool/UI.tsx picks its one-liner with `includes` on these, so an
    // overlap would silently route two states to the same label.
    const all = [
      FILE_NOT_READ_ERROR,
      FILE_PARTIAL_VIEW_ERROR,
      FILE_CLIPPED_VIEW_ERROR,
    ]
    for (const a of all) {
      for (const b of all) {
        if (a !== b) expect(a.includes(b)).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Coverage lane: "saw the file" vs "saw the lines being changed".
// ---------------------------------------------------------------------------

/** A range read of lines 5-7 of a longer file. */
const RANGE = state({ content: 'five\nsix\nseven', offset: 5, limit: 3 })

describe('isWholeFileView', () => {
  test('a full Read and a post-write entry both stand for the whole file', () => {
    // FileReadTool writes offset 1 for a full read; Edit/Write/stagedWrite and
    // BashTool all write offset: undefined with the complete new content.
    expect(isWholeFileView(state({ offset: 1 }))).toBe(true)
    expect(isWholeFileView(state({ offset: undefined }))).toBe(true)
  })

  test('a range or symbol read does not', () => {
    expect(isWholeFileView(RANGE)).toBe(false)
    expect(isWholeFileView(state({ offset: 1, limit: 5 }))).toBe(false)
  })
})

describe('seenRegionCovers', () => {
  test('a whole-file entry covers anything', () => {
    expect(seenRegionCovers(state({ content: 'a\nb' }), ['zzz'])).toBe(true)
  })

  test('a range entry covers a run inside it', () => {
    expect(seenRegionCovers(RANGE, ['five', 'six'])).toBe(true)
  })

  test('a range entry does NOT cover a run outside it', () => {
    expect(seenRegionCovers(RANGE, ['eight'])).toBe(false)
  })

  test('matching is line-anchored, not substring', () => {
    // Without the newline sentinels, "ix" would "match" inside "six" and a
    // patch anchored on a line the model never saw would sail through.
    expect(seenRegionCovers(RANGE, ['ix'])).toBe(false)
  })

  test('indentation drift is tolerated', () => {
    // Both callers match fuzzily on whitespace; this lane must never be the
    // stricter of the two, or it refuses writes that would have applied.
    expect(seenRegionCovers(RANGE, ['    six'])).toBe(true)
  })

  test('a blank-only run localizes nothing and is not refused', () => {
    expect(seenRegionCovers(RANGE, ['', ''])).toBe(true)
  })

  test('the killswitch disables it', () => {
    process.env.CLAUDIN_DISABLE_READ_COVERAGE_GATE = '1'
    try {
      expect(seenRegionCovers(RANGE, ['eight'])).toBe(true)
      expect(needsWholeFileRead(RANGE)).toBe(false)
    } finally {
      delete process.env.CLAUDIN_DISABLE_READ_COVERAGE_GATE
    }
  })
})

describe('needsWholeFileRead', () => {
  test('true for a range entry, false for a whole-file one', () => {
    expect(needsWholeFileRead(RANGE)).toBe(true)
    expect(needsWholeFileRead(state({ offset: 1 }))).toBe(false)
  })
})

describe('seenRangeLabel', () => {
  test('reports the lines the entry actually spans', () => {
    expect(seenRangeLabel(RANGE)).toBe('lines 5-7')
  })

  test('a trailing newline does not add a phantom line', () => {
    expect(seenRangeLabel(state({ content: 'a\nb\n', offset: 10 }))).toBe(
      'lines 10-11',
    )
  })

  test('singular for one line', () => {
    expect(seenRangeLabel(state({ content: 'a', offset: 42 }))).toBe('line 42')
  })
})

describe('coverage messages', () => {
  test('the unseen-region refusal names the range AND the remedy', () => {
    const m = unseenRegionMessage('src/a.ts', 'patching it', RANGE)
    expect(m).toContain('src/a.ts')
    expect(m).toContain('lines 5-7')
    expect(m).toContain("view='full'")
    expect(m).toContain('patching it')
    // It must not repeat the falsehood the gate messages were split up to fix.
    expect(m).not.toContain('has not been read yet')
  })

  test('the whole-file refusal says why a range is not enough', () => {
    const m = wholeFileRequiredMessage('File', 'Deleting it', RANGE)
    expect(m).toContain('replaces the whole file')
    expect(m).toContain("view='full'")
  })
})

// ---------------------------------------------------------------------------
// Wiring. The four call sites live in tool `validateInput` bodies that cannot
// be driven under `bun test` — sibling files in the shard globally mock `fs`
// and `fs/promises` (see FileEditTool.diagnostics.test.ts's header, and
// .claudin/rules/testing.md on cross-file mock leaks). Without this block,
// deleting a tool's call to the shared helper and restoring its old flat
// "has not been read yet" string breaks nothing, which is exactly the hole an
// audit found in the first version of this change.
// ---------------------------------------------------------------------------

const CALL_SITES: Array<[string, URL]> = [
  ['Edit', new URL('../FileEditTool/FileEditTool.ts', import.meta.url)],
  ['Write', new URL('../FileWriteTool/FileWriteTool.ts', import.meta.url)],
  [
    'NotebookEdit',
    new URL('../NotebookEditTool/NotebookEditTool.ts', import.meta.url),
  ],
  ['apply_patch', new URL('../ApplyPatchTool/applyPatch.ts', import.meta.url)],
]

describe('read-before-edit gate wiring (the four-tool invariant)', () => {
  for (const [tool, url] of CALL_SITES) {
    test(`${tool} routes its refusal through the shared module`, () => {
      const src = readFileSync(url, 'utf8')
      expect(src).toContain('satisfiesReadGate(readTimestamp)')
      expect(src).toContain('readBeforeEditMessages.js')
    })

    test(`${tool} no longer hardcodes the old flat refusal`, () => {
      const src = readFileSync(url, 'utf8')
      // The exact string the three write tools used to emit for a partial
      // view. It may only appear via the shared constant now.
      expect(src).not.toContain(
        "'File has not been read yet. Read it first before writing to it.'",
      )
    })
  }
})

// Same reasoning for the coverage lane: apply_patch's half is driven for real
// in applyPatch.test.ts, but Edit's and Write's validateInput cannot run here,
// so deleting their call would otherwise cost nothing.
describe('read-coverage wiring', () => {
  test('Edit checks the region its old_string lands in', () => {
    const src = readFileSync(CALL_SITES[0][1], 'utf8')
    expect(src).toContain("seenRegionCovers(readTimestamp, old_string.split('\\n'))")
  })

  test('Write demands a whole-file read before overwriting', () => {
    const src = readFileSync(CALL_SITES[1][1], 'utf8')
    expect(src).toContain('needsWholeFileRead(readTimestamp)')
  })
})
