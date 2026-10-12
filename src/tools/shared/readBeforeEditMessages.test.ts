import { readFileSync } from 'fs'
import { describe, expect, test } from 'bun:test'
import type { FileState } from 'src/shared/fs/fileStateCache.js'
import {
  FILE_CHANGED_TOO_LARGE_ERROR,
  FILE_CLIPPED_VIEW_ERROR,
  FILE_NOT_READ_ERROR,
  FILE_PARTIAL_VIEW_ERROR,
  appliedUnreadNote,
  coveredSegments,
  isWholeFileView,
  needsWholeFileRead,
  readGateMessage,
  readGateReasonFor,
  satisfiesReadGate,
  seenRangeLabel,
  unreadRefusal,
  wholeFileRequiredMessage,
  writeFamilyReadGateError,
} from 'src/tools/shared/readBeforeEditMessages.js'

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

/** What the changed-files watcher leaves when it cannot re-read a changed file whole. */
const CHANGED_TOO_LARGE = state({
  content: '',
  isPartialView: true,
  refreshFailed: 'too-large',
} as Partial<FileState>)

describe('satisfiesReadGate', () => {
  test('a full read passes', () => {
    expect(satisfiesReadGate(state())).toBe(true)
  })

  test('a missing entry fails', () => {
    expect(satisfiesReadGate(undefined)).toBe(false)
  })

  test('a partial view fails even though an entry exists', () => {
    // The whole-file invariant in .claudin/rules/cache.md: for a write that
    // replaces the file, presence does not mean "the model saw these bytes".
    expect(satisfiesReadGate(state({ isPartialView: true }))).toBe(false)
  })

  test('a clipped entry fails', () => {
    expect(satisfiesReadGate(CLIPPED)).toBe(false)
  })

  test('a too-large marker fails', () => {
    expect(satisfiesReadGate(CHANGED_TOO_LARGE)).toBe(false)
  })

  test('an injected, stripped file fails: written back, it would lose what was stripped', () => {
    const injected = state({
      content: '---\npaths: src/**\n---\n# Rule\n\nDo the thing.\n',
      isPartialView: true,
      injectedView: '# Rule\n\nDo the thing.',
    } as Partial<FileState>)
    expect(satisfiesReadGate(injected)).toBe(false)
  })
})

describe('readGateReasonFor', () => {
  test('distinguishes the four failure causes', () => {
    expect(readGateReasonFor(undefined)).toBe('never-read')
    expect(readGateReasonFor(state({ isPartialView: true }))).toBe(
      'partial-view',
    )
    expect(readGateReasonFor(CLIPPED)).toBe('clipped')
    expect(readGateReasonFor(CHANGED_TOO_LARGE)).toBe('changed-too-large')
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

  test('changed-too-large sends the model to a range read, never to view=full', () => {
    // view='full' is what "has not been read yet" led to, and it fails on the
    // same cap that stopped the watcher: 5 "exceeds maximum allowed tokens"
    // errors in the 2026-09-14..20 corpus.
    const m = readGateMessage('changed-too-large', 'src/a.ts', 'patching it')
    expect(m).toContain('changed on disk')
    expect(m).toContain('too large to re-read whole')
    expect(m).toContain('offset/limit')
    expect(m).not.toContain("view='full'")
    expect(m).not.toContain('has not been read yet')
  })

  test('every reason threads the caller subject and action', () => {
    for (const reason of [
      'never-read',
      'partial-view',
      'clipped',
      'changed-too-large',
    ] as const) {
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
    expect(writeFamilyReadGateError(CHANGED_TOO_LARGE)).toBe(
      FILE_CHANGED_TOO_LARGE_ERROR,
    )
  })

  test('the four constants are mutually non-substring', () => {
    // FileEditTool/UI.tsx picks its one-liner with `includes` on these, so an
    // overlap would silently route two states to the same label.
    const all = [
      FILE_NOT_READ_ERROR,
      FILE_PARTIAL_VIEW_ERROR,
      FILE_CLIPPED_VIEW_ERROR,
      FILE_CHANGED_TOO_LARGE_ERROR,
    ]
    for (const a of all) {
      for (const b of all) {
        if (a !== b) expect(a.includes(b)).toBe(false)
      }
    }
  })
})

describe('in-place writes on a file never read', () => {
  test('the refusal says why it was not written unread', () => {
    expect(unreadRefusal(FILE_NOT_READ_ERROR, 'old_string does not occur in it exactly once', 'edited')).toBe(
      'File has not been read yet. Read it first before writing to it. old_string does not occur in it exactly once, so it was not edited unread.',
    )
  })

  test('a write that went through says the file had not been read', () => {
    expect(appliedUnreadNote('src/a.ts', 'edited because old_string matched it exactly once')).toBe(
      'Note: src/a.ts had not been read — edited because old_string matched it exactly once.',
    )
  })
})

// ---------------------------------------------------------------------------
// Whole-file coverage: a write that replaces the file needs all of it read.
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

describe('needsWholeFileRead', () => {
  test('true for a range entry, false for a whole-file one', () => {
    expect(needsWholeFileRead(RANGE)).toBe(true)
    expect(needsWholeFileRead(state({ offset: 1 }))).toBe(false)
  })

  test('the killswitch disables it', () => {
    process.env.CLAUDIN_DISABLE_READ_COVERAGE_GATE = '1'
    try {
      expect(needsWholeFileRead(RANGE)).toBe(false)
    } finally {
      delete process.env.CLAUDIN_DISABLE_READ_COVERAGE_GATE
    }
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

describe('the whole-file refusal', () => {
  test('the whole-file refusal says why a range is not enough', () => {
    const m = wholeFileRequiredMessage('File', 'Writing to it', RANGE)
    expect(m).toContain('lines 5-7')
    expect(m).toContain('replaces the whole file')
    expect(m).toContain("view='full'")
    // It must not repeat the falsehood the gate messages were split up to fix.
    expect(m).not.toContain('has not been read yet')
  })
})

// ---------------------------------------------------------------------------
// The accumulated lane: several reads of ONE version of a file.
//
// The entry carries the earlier slices (`carrySeenRanges`, fileStateCache.ts)
// and this module decides what they add up to. What is pinned here is that they
// add up to CONTIGUOUS runs and nothing more: joining two slices across a gap
// would invent adjacency the model never saw.
// ---------------------------------------------------------------------------

type Slice = { offset: number; content: string }

/** `count` lines named l<n>, starting at `offset`. */
function slice(offset: number, count: number): Slice {
  return {
    offset,
    content: Array.from({ length: count }, (_, i) => `l${offset + i}`).join(
      '\n',
    ),
  }
}

/** An entry whose newest read is `head`, carrying `rest` from earlier reads. */
function walked(head: Slice, ...rest: Slice[]): FileState {
  return state({
    content: head.content,
    offset: head.offset,
    limit: head.content.split('\n').length,
    seenRanges: rest,
  } as Partial<FileState>)
}

describe('coveredSegments', () => {
  test('slices that touch become one run', () => {
    const segments = coveredSegments(walked(slice(11, 5), slice(1, 10)))
    expect(segments).toHaveLength(1)
    expect(segments[0]!.offset).toBe(1)
    expect(segments[0]!.lines).toHaveLength(15)
  })

  test('slices that overlap are not double-counted', () => {
    // l8-l10 arrive twice. Appending blindly would make the run 15 lines long
    // and shift every line after the seam, so a hunk anchored past it would be
    // matched against text at the wrong place.
    const segments = coveredSegments(walked(slice(8, 5), slice(1, 10)))
    expect(segments).toHaveLength(1)
    expect(segments[0]!.lines).toHaveLength(12)
    expect(segments[0]!.lines[11]).toBe('l12')
  })

  test('a gap stays a gap', () => {
    const segments = coveredSegments(walked(slice(40, 6), slice(1, 10)))
    expect(segments.map(s => s.offset)).toEqual([1, 40])
  })

  test('a slice entirely inside another contributes nothing', () => {
    const segments = coveredSegments(walked(slice(3, 2), slice(1, 10)))
    expect(segments).toHaveLength(1)
    expect(segments[0]!.lines).toHaveLength(10)
  })
})

describe('seenRangeLabel — accumulated', () => {
  test('names every segment, not just the newest read', () => {
    // The refusal tells the model what it has already been shown. Naming only
    // the newest slice sends it to re-read lines it is holding — the ritual
    // re-read these messages exist to prevent.
    expect(seenRangeLabel(walked(slice(40, 6), slice(1, 10)))).toBe(
      'lines 1-10, 40-45',
    )
  })

  test('merged slices read as one span', () => {
    expect(seenRangeLabel(walked(slice(11, 5), slice(1, 10)))).toBe(
      'lines 1-15',
    )
  })
})
// ---------------------------------------------------------------------------
// Wiring. Write's and Edit's validators are driven for real in their own
// readGate tests and Patch's in applyPatch.test.ts; NotebookEdit's is not, and
// without this block deleting its call to the shared gate and restoring the
// old flat "has not been read yet" string would break nothing — the hole an
// audit found in the first version of this change.
// ---------------------------------------------------------------------------

const CALL_SITES: Array<[string, URL]> = [
  ['Edit', new URL('../FileEditTool/FileEditTool.ts', import.meta.url)],
  ['Write', new URL('../FileWriteTool/FileWriteTool.ts', import.meta.url)],
  [
    'NotebookEdit',
    new URL('../NotebookEditTool/NotebookEditTool.ts', import.meta.url),
  ],
]

describe('read-before-edit gate wiring', () => {
  for (const [tool, url] of CALL_SITES) {
    test(`${tool} routes its refusal through the shared module`, () => {
      const src = readFileSync(url, 'utf8')
      // Edit writes in place, like Patch; Write and NotebookEdit replace
      // content the model may not have seen and keep the whole-file gate.
      if (tool === 'Edit') {
        expect(src).toContain('unreadRefusal(')
        expect(src).not.toContain('satisfiesReadGate')
      } else {
        expect(src).toContain('satisfiesReadGate(readTimestamp)')
      }
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

describe('whole-file coverage wiring', () => {
  test('Write demands a whole-file read before overwriting', () => {
    const src = readFileSync(CALL_SITES[1][1], 'utf8')
    expect(src).toContain('needsWholeFileRead(readTimestamp)')
  })
})
