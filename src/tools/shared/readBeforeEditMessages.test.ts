import { readFileSync } from 'fs'
import { describe, expect, test } from 'bun:test'
import type { FileState } from 'src/shared/fs/fileStateCache.js'
import {
  FILE_CLIPPED_VIEW_ERROR,
  FILE_NOT_READ_ERROR,
  FILE_PARTIAL_VIEW_ERROR,
  coveredSegments,
  isWholeFileView,
  needsWholeFileRead,
  readGateMessage,
  readGateReasonFor,
  satisfiesLineScopedReadGate,
  satisfiesReadGate,
  seenRangeLabel,
  seenRegionCovers,
  seenRegionCoversText,
  unseenRegionMessage,
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

/** A CLAUDE.md the harness injected with its frontmatter stripped. */
const INJECTED = state({
  content: '---\npaths: src/**\n---\n# Rule\n\nDo the thing.\n',
  isPartialView: true,
  injectedView: '# Rule\n\nDo the thing.',
} as Partial<FileState>)

describe('satisfiesLineScopedReadGate', () => {
  test('agrees with the whole-file gate on ordinary entries', () => {
    expect(satisfiesLineScopedReadGate(state())).toBe(true)
    expect(satisfiesLineScopedReadGate(undefined)).toBe(false)
    expect(satisfiesLineScopedReadGate(state({ isPartialView: true }))).toBe(
      false,
    )
    expect(satisfiesLineScopedReadGate(CLIPPED)).toBe(false)
  })

  test('opens for an injected entry, which the whole-file gate refuses', () => {
    // 8 of 65 gate refusals in the corpus were Edits of an injected
    // MEMORY.md/rule the model had just been shown. Write must still refuse:
    // written back from a truncated view, the file would lose its tail.
    expect(satisfiesLineScopedReadGate(INJECTED)).toBe(true)
    expect(satisfiesReadGate(INJECTED)).toBe(false)
  })

  test('a clip-pin marker over an injected entry keeps it shut', () => {
    const marked = state({
      ...INJECTED,
      standDownOutline: CLIPPED.standDownOutline,
    } as Partial<FileState>)
    expect(satisfiesLineScopedReadGate(marked)).toBe(false)
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

describe('coverage against an injected view', () => {
  test('what the model saw covers; what was stripped does not', () => {
    // The entry's `content` is the raw file and would cover the frontmatter;
    // the model never saw it, so it must not.
    expect(seenRegionCovers(INJECTED, ['Do the thing.'])).toBe(true)
    expect(seenRegionCovers(INJECTED, ['paths: src/**'])).toBe(false)
    expect(seenRegionCoversText(INJECTED, 'the thing')).toBe(true)
    expect(seenRegionCoversText(INJECTED, 'paths:')).toBe(false)
  })

  test('the whole-file short-circuit does not apply to it', () => {
    // offset/limit are undefined on an injected entry (getChangedFiles skips
    // range entries), which reads as whole-file everywhere else.
    expect(isWholeFileView(INJECTED)).toBe(true)
    expect(seenRegionCoversText(INJECTED, 'zzz')).toBe(false)
  })

  test('the refusal says what happened instead of quoting raw line numbers', () => {
    const m = unseenRegionMessage('File', 'editing it', INJECTED)
    expect(m).toContain('injected')
    expect(m).toContain("view='full'")
    expect(m).toContain('editing it')
    expect(m).not.toContain('lines 1-')
  })
})

describe('seenRegionCoversText (Edit old_string)', () => {
  /** Lines 10-12 of a file, read as a range. */
  const SUBLINE = state({
    content: 'a\n  const msg = "alpha beta"\nc',
    offset: 10,
    limit: 3,
  })

  test('a substring inside one seen line is covered', () => {
    // The refusal this pins: effort.tsx line 220 was read (214-225) and again
    // (200-239), and an Edit of a fragment of that line was refused both
    // times because `seenRegionCovers` demanded a whole line.
    expect(seenRegionCoversText(SUBLINE, 'beta')).toBe(true)
    expect(seenRegionCoversText(SUBLINE, 'msg = "alpha')).toBe(true)
  })

  test('a needle starting and ending mid-line across seen lines is covered', () => {
    expect(seenRegionCoversText(SUBLINE, 'beta"\nc')).toBe(true)
    expect(seenRegionCoversText(SUBLINE, 'a\n  const')).toBe(true)
  })

  test('a needle on a line the model never saw is not', () => {
    expect(seenRegionCoversText(SUBLINE, 'gamma')).toBe(false)
    expect(seenRegionCoversText(RANGE, 'eight')).toBe(false)
  })

  test('middle lines stay line-anchored', () => {
    // The inner newline is kept, so a needle that continues onto a line the
    // model did not see is refused even though its first line was seen.
    expect(seenRegionCoversText(SUBLINE, 'beta"\nzzz')).toBe(false)
  })

  test('a needle spanning the gap between two reads is refused', () => {
    const entry = walked(slice(40, 6), slice(1, 10))
    expect(seenRegionCoversText(entry, 'l10\nl40')).toBe(false)
    expect(seenRegionCoversText(entry, '9\nl10')).toBe(true)
  })

  test('indentation drift and a blank-only needle are tolerated', () => {
    expect(seenRegionCoversText(SUBLINE, '        const msg')).toBe(true)
    expect(seenRegionCoversText(SUBLINE, '\n  \n')).toBe(true)
  })

  test('a whole-file entry covers anything', () => {
    expect(seenRegionCoversText(state({ content: 'a\nb' }), 'zzz')).toBe(true)
  })

  test('the killswitch disables it', () => {
    process.env.CLAUDIN_DISABLE_READ_COVERAGE_GATE = '1'
    try {
      expect(seenRegionCoversText(SUBLINE, 'gamma')).toBe(true)
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
// The accumulated lane: several reads of ONE version of a file.
//
// The entry carries the earlier slices (`carrySeenRanges`, fileStateCache.ts)
// and this module decides what they add up to. What is pinned here is that they
// add up to CONTIGUOUS runs and nothing more: joining two slices across a gap
// would invent adjacency the model never saw and wave through a patch whose
// context spans lines nobody read.
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

describe('seenRegionCovers — across accumulated reads', () => {
  test('an EARLIER read still covers, after a narrower one replaced it', () => {
    // 9 of the 37 unseen-region refusals in the session corpus were hunks
    // sitting whole inside a slice the model had read, which a later, narrower
    // Read had evicted from the entry.
    const entry = walked(slice(40, 6), slice(1, 10))
    expect(seenRegionCovers(entry, ['l3', 'l4'])).toBe(true)
    expect(seenRegionCovers(entry, ['l41'])).toBe(true)
  })

  test('a hunk spanning the seam of two adjacent reads is covered', () => {
    // The other 19: no single read contains the hunk, the union does.
    const entry = walked(slice(11, 5), slice(1, 10))
    expect(seenRegionCovers(entry, ['l9', 'l10', 'l11', 'l12'])).toBe(true)
  })

  test('a hunk inside the gap is still refused', () => {
    const entry = walked(slice(40, 6), slice(1, 10))
    expect(seenRegionCovers(entry, ['l20'])).toBe(false)
  })

  test('a hunk spanning the gap is refused, however the slices are arranged', () => {
    // The failure a naive concatenation would ship: l10 and l40 are both in the
    // entry and adjacent in the concatenated text, 29 lines apart in the file.
    // A patch anchored on that pair must not be authorized.
    const entry = walked(slice(40, 6), slice(1, 10))
    expect(seenRegionCovers(entry, ['l10', 'l40'])).toBe(false)
  })

  test('the killswitch disables the accumulated lane too', () => {
    process.env.CLAUDIN_DISABLE_READ_COVERAGE_GATE = '1'
    try {
      expect(
        seenRegionCovers(walked(slice(40, 6), slice(1, 10)), ['l20']),
      ).toBe(true)
    } finally {
      delete process.env.CLAUDIN_DISABLE_READ_COVERAGE_GATE
    }
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
      // Edit and an apply_patch Update are line-scoped and may take the
      // injected-view exception; Write and NotebookEdit replace content the
      // model may not have seen and must not.
      expect(src).toContain(
        tool === 'Edit' || tool === 'apply_patch'
          ? 'satisfiesLineScopedReadGate(readTimestamp)'
          : 'satisfiesReadGate(readTimestamp)',
      )
      if (tool === 'Write' || tool === 'NotebookEdit') {
        expect(src).not.toContain('satisfiesLineScopedReadGate')
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

// Same reasoning for the coverage lane: apply_patch's half is driven for real
// in applyPatch.test.ts, but Edit's and Write's validateInput cannot run here,
// so deleting their call would otherwise cost nothing.
describe('read-coverage wiring', () => {
  test('Edit checks the region its old_string lands in', () => {
    const src = readFileSync(CALL_SITES[0][1], 'utf8')
    // The substring predicate, not the line one: an `old_string` that starts
    // mid-line must not be refused for a line the model was shown.
    expect(src).toContain('seenRegionCoversText(readTimestamp, old_string)')
    expect(src).not.toContain("old_string.split('\\n')")
  })

  test('Write demands a whole-file read before overwriting', () => {
    const src = readFileSync(CALL_SITES[1][1], 'utf8')
    expect(src).toContain('needsWholeFileRead(readTimestamp)')
  })
})
