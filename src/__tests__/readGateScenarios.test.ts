// The auto-outline pivot is behind a build-time flag the test preload stubs to
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import {
  READ_AUTO_OUTLINE_THRESHOLD_CHARS,
  READ_AUTO_OUTLINE_THRESHOLD_LINES,
} from 'src/tools/FileReadTool/outlineView.js'
import { validateApplyPatchInput } from 'src/tools/ApplyPatchTool/applyPatch.js'
import { refreshChangedFile } from 'src/agent/attachments/changedFile.js'

// ---------------------------------------------------------------------------
// End-to-end read-gate scenarios: the real Read tool writes the cache entry,
// and the real apply_patch validator reads it. Everything else in this area is
// unit-tested against a HAND-SEEDED entry, which is precisely how both of these
// bugs survived — a fabricated entry cannot show that Read wrote the wrong one.
//
// Reproduced here, from the 683-session corpus:
//   S1  a file walked in two ranges, patched inside the first    (28/37 refusals)
//   S2  a narrow Read landing on a full one                      (561 occurrences)
//   S3  an out-of-band rewrite downgrading the entry to outline  (38/50 refusals)
//   S4  the same when the file cannot be re-read                 (blind-write guard)
//   S5  accumulated coverage must not survive a changed file     (blind-write guard)
// ---------------------------------------------------------------------------

/**
 * S3/S4 need the auto-outline pivot, which is behind a build-time flag the test
 * preload stubs to `false`.
 *
 * Set in `beforeAll` and restored, NOT at module scope: bun runs the whole
 * suite in one process, so a module-scope `process.env` write leaks into every
 * file that runs after this one — and this file, under `src/__tests__/`, runs
 * near the front. The first version did exactly that and broke 16 tests across
 * four unrelated suites while passing in isolation, which is the shape
 * .claudin/rules/testing.md warns about. Both flags are read at call time.
 */
const FLAGS = [
  'CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION',
  'CLAUDIN_DISABLE_TOOL_RESULT_CACHE',
] as const
const priorFlags = new Map<string, string | undefined>()

let dir: string
let ctx: ToolUseContext

beforeAll(() => {
  for (const flag of FLAGS) {
    priorFlags.set(flag, process.env[flag])
    process.env[flag] = '1'
  }
  // Defend against an fs mock leaked from another file in the shard.
  setOriginalFsImplementation()
  dir = mkdtempSync(join(tmpdir(), 'read-gate-'))
})

afterAll(() => {
  for (const [flag, value] of priorFlags) {
    if (value === undefined) delete process.env[flag]
    else process.env[flag] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

function makeContext(fileReadingLimits?: {
  maxSizeBytes: number
  maxTokens: number
}): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    fileReadingLimits,
    updateFileHistoryState: () => {},
    agentId: undefined,
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

beforeEach(() => {
  ctx = makeContext()
})

/** `count` lines named <prefix><n>, so a range read can miss the patched one. */
function writeLines(path: string, count: number, prefix = 'l'): void {
  writeFileSync(
    path,
    Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join('\n') +
      '\n',
  )
}

/** Rewrite out of band (a build, a `perl -i`, a `git checkout`). */
function rewriteAhead(path: string, body: string, secondsAhead = 10): void {
  writeFileSync(path, body)
  const when = new Date(Date.now() + secondsAhead * 1000)
  utimesSync(path, when, when)
}

async function read(
  path: string,
  input: { offset?: number; limit?: number; view?: 'full' | 'outline' } = {},
): Promise<void> {
  await FileReadTool.call(
    { file_path: path, ...input } as never,
    ctx,
  )
}

function patch(path: string, body: string) {
  return validateApplyPatchInput(
    { patchText: `*** Begin Patch\n*** Update File: ${path}\n${body}\n*** End Patch` },
    ctx,
  )
}

function refusal(result: ReturnType<typeof patch>): string {
  if (result.result) throw new Error('expected a refusal, got a pass')
  return result.message
}

describe('S1 — a file walked in two ranges', () => {
  test('a patch inside the FIRST range is authorized', async () => {
    // Before the accumulation the entry stood for the last Read alone, so this
    // was refused with "only read in part (lines 40-45)" — naming lines the
    // model was holding while claiming it had not seen l3.
    const p = join(dir, 's1-first.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })
    await read(p, { offset: 40, limit: 6 })

    expect(patch(p, '@@\n-l3\n+L3')).toEqual({ result: true })
  })

  test('a patch in the GAP between them is still refused', async () => {
    const p = join(dir, 's1-gap.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })
    await read(p, { offset: 40, limit: 6 })

    const message = refusal(patch(p, '@@\n-l20\n+L20'))
    expect(message).toContain('only read in part')
    // The refusal names everything the model has been shown, both ranges.
    expect(message).toContain('lines 1-10, 40-45')
  })

  test('a patch whose context spans the gap is refused', async () => {
    // l10 and l40 are both in the entry and adjacent in the accumulated text,
    // 29 lines apart in the file. Concatenating the slices instead of merging
    // them by line number would authorize this.
    const p = join(dir, 's1-span.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })
    await read(p, { offset: 40, limit: 6 })

    expect(patch(p, '@@\n l10\n-l40\n+L40').result).toBe(false)
  })
})

describe('S2 — a narrow Read landing on a full one', () => {
  test('the full read still authorizes a patch elsewhere in the file', async () => {
    // The clobber: 561 whole-file entries in the corpus were destroyed this
    // way. The model reads a file, then reads eight lines of it to re-check
    // something, and its next patch is refused.
    const p = join(dir, 's2.txt')
    writeLines(p, 60)
    await read(p)
    await read(p, { offset: 40, limit: 6 })

    expect(patch(p, '@@\n-l3\n+L3')).toEqual({ result: true })
  })
})

describe('S3 — an out-of-band rewrite of a file the model had read in full', () => {
  /** Over READ_AUTO_OUTLINE_THRESHOLD_CHARS, over MIN_SYMBOLS (3). */
  const bigSource = (marker: string): string =>
    Array.from(
      { length: 60 },
      (_, i) =>
        `export function fn${i}(): string {\n` +
        `  // ${marker} ${'padding '.repeat(40)}\n` +
        `  return '${marker}${i}'\n}\n`,
    ).join('\n')

  test('the fixture actually crosses the auto-outline threshold', () => {
    // Without this the scenario is a tautology: the first version of this
    // fixture was ~9,079 chars / 199 lines, under both triggers, so it passed
    // with `view: 'full'` deleted from the production path.
    expect(bigSource('X').length).toBeGreaterThanOrEqual(
      READ_AUTO_OUTLINE_THRESHOLD_CHARS,
    )
    expect(bigSource('X').split('\n').length).toBeGreaterThanOrEqual(
      READ_AUTO_OUTLINE_THRESHOLD_LINES,
    )
  })

  test('the model is told, and can still patch the file', async () => {
    const p = join(dir, 's3.ts')
    writeFileSync(p, bigSource('BEFORE'))
    // The shape Edit/Write/apply_patch leave behind: whole file, no offset.
    ctx.readFileState.set(p, {
      content: bigSource('BEFORE'),
      timestamp: getFileModificationTime(p),
      offset: undefined,
      limit: undefined,
    })

    rewriteAhead(p, bigSource('AFTER'))
    const attachment = await refreshChangedFile(
      p,
      p,
      ctx.readFileState.get(p)!,
      ctx,
    )

    // Half one: the change reaches the model at all. With a vanilla Read the
    // pivot answered with an outline, which is neither 'text' nor 'image', and
    // this was null.
    expect(attachment).toMatchObject({ type: 'edited_text_file' })

    // Half two: the entry is still a full view of the file, so the next write
    // is not refused with a message claiming the model only saw an outline.
    expect(patch(p, "@@\n-  return 'AFTER0'\n+  return 'PATCHED'")).toEqual({
      result: true,
    })
  })
})

describe('S4 — the rewritten file can no longer be re-read', () => {
  test('the stale entry is dropped, and the next patch is refused', async () => {
    // The blind-write guard for the case the fix could have opened: when the
    // re-read cannot produce the new bytes, the entry must stop vouching for
    // the file rather than keep describing a version that is gone. Refusing
    // with "has not been read yet" is true here, and it terminates — a stale
    // entry with a refreshed timestamp would have been the silent version.
    const p = join(dir, 's4.ts')
    const before = Array.from(
      { length: 40 },
      (_, i) => `export function fn${i}(): number {\n  return ${i}\n}\n`,
    ).join('\n')
    writeFileSync(p, before)
    ctx = makeContext({ maxSizeBytes: 512, maxTokens: 25_000 })
    ctx.readFileState.set(p, {
      content: before,
      timestamp: getFileModificationTime(p),
      offset: undefined,
      limit: undefined,
    })

    rewriteAhead(p, before.replace(/return 0/, 'return 999'))
    expect(
      await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx),
    ).toBeNull()

    expect(ctx.readFileState.has(p)).toBe(false)
    expect(refusal(patch(p, '@@\n-  return 1\n+  return 2'))).toContain(
      'has not been read yet',
    )
  })
})

describe('S5 — accumulated coverage does not survive a changed file', () => {
  test('a rewrite between two range reads drops what was carried', async () => {
    // The invariant the accumulation rests on. The model read l1-l10, the file
    // was rewritten underneath it, and it then read lines 40-45 of the NEW
    // file. Authorizing a patch against l3 there would be a write against
    // bytes that no longer exist — the exact hazard the coverage gate exists
    // to prevent, arriving through the feature meant to relax it.
    const p = join(dir, 's5.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })

    rewriteAhead(
      p,
      Array.from({ length: 60 }, (_, i) => `L${i + 1}`).join('\n') + '\n',
    )
    await read(p, { offset: 40, limit: 6 })

    expect(patch(p, '@@\n-l3\n+X3').result).toBe(false)
    // And the refusal describes only what is still true.
    expect(refusal(patch(p, '@@\n-l3\n+X3'))).toContain('lines 40-45')
  })
})
