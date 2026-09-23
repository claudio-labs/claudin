// The auto-outline pivot is behind a build-time flag the test preload stubs to
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  FileStateCache,
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
import { ApplyPatchTool } from 'src/tools/ApplyPatchTool/ApplyPatchTool.js'
import { RESUBMIT_SENTINEL } from 'src/tools/ApplyPatchTool/patchFormat.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { createPlanAttachmentIfNeeded } from 'src/agent/compact/postCompactAttachments.js'
import {
  getChangedFileAttachments,
  refreshChangedFile,
} from 'src/agent/attachments/changedFile.js'

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
//
// And from the 2026-09-14..20 census (tool-error-census-2026-09-20.md), where a
// third of the read-gate refusals were the harness losing state it had:
//   S6  Read(range), then the file changes OUTSIDE the range     (19 `sed -i` stale refusals)
//   S7  Read(range), then the file changes INSIDE the range      (the model is told)
//   S8  Read(range), then a touch with identical bytes           (4 `bun run build` refusals)
//   S9  two ranges, one of them rewritten                        (coverage survives per slice)
//   S10 a write, a watcher pass, then a new Read                 (16 "wrote-then-lost")
//   S11 compaction clears the cache, the plan comes back as an attachment (5 refusals in a row)
//   S12 a whole-file entry over the cap changes on disk          (evicted as "not read yet")
//   S13 Read(range) then a patch on the import block             (52 of 102 coverage refusals)
//   S14 after a refresh, a re-Read returns the body, not a stub  (the "re-read that breaks")
//   S15 outline, then Read(range), then a patch outside the range (a blind-write hole)
//
// And from session-cache-ab (2026-09-23), where every rep read the fixture with
// a Bash `cat` loop and then re-read each file with Read to be allowed to edit:
//   S16 a `cat` credited as a read, then a patch                  (CLAUDIN_BASH_READ_CREDIT)
//
// And from the same bench, where 24 of 63 sessions re-sent a whole patch after
// a refusal that had already served the lines it needed:
//   S17 a refused patch resubmitted by reference                  (`*** Resubmit`)
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

/** One watcher pass, exactly as the attachment pipeline runs it after every tool iteration. */
function watcherPass() {
  return getChangedFileAttachments(ctx)
}

/** Bump the mtime without changing a byte — what `bun run build`'s in-place feature() pass leaves behind. */
function touchAhead(path: string, secondsAhead = 10): void {
  const when = new Date(Date.now() + secondsAhead * 1000)
  utimesSync(path, when, when)
}

function linesWith(count: number, replace: Record<number, string>): string {
  return (
    Array.from({ length: count }, (_, i) => replace[i + 1] ?? `l${i + 1}`).join('\n') +
    '\n'
  )
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
  test('the stale entry stops vouching for the file, and the next patch is refused', async () => {
    // The blind-write guard for the case the fix could have opened: when the
    // re-read cannot produce the new bytes, the entry must stop vouching for
    // the file rather than keep describing a version that is gone. It used to
    // be evicted and refused as "has not been read yet"; S12 below pins the
    // marker that replaced the eviction and the message it carries.
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

    expect(patch(p, '@@\n-  return 1\n+  return 2').result).toBe(false)
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

describe('S6 — Read(range), then the file changes outside the range', () => {
  test('the watcher refreshes the entry and the patch inside the range passes', async () => {
    // 19 of the 30 "modified since read" refusals this week: the model read a
    // slice, deleted a line range elsewhere with `sed -i`, and its next patch
    // inside the slice was refused — the watcher skipped every Read entry, so
    // the change was never absorbed and the model had to re-read what it was
    // already holding.
    const p = join(dir, 's6.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })

    rewriteAhead(p, linesWith(60, { 40: 'L40' }))
    const attachments = await watcherPass()

    // The slice the model holds is unchanged, so there is nothing to tell it.
    expect(attachments).toEqual([])
    expect(patch(p, '@@\n-l3\n+L3')).toEqual({ result: true })
  })
})

describe('S7 — Read(range), then the file changes inside the range', () => {
  test('the model is told what changed and can patch the new text', async () => {
    const p = join(dir, 's7.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })

    rewriteAhead(p, linesWith(60, { 3: 'L3' }))
    const attachments = await watcherPass()

    expect(attachments).toHaveLength(1)
    const [attachment] = attachments
    expect(attachment).toMatchObject({ type: 'edited_text_file', filename: p })
    // The snippet is numbered in FILE lines, not slice lines.
    expect((attachment as { snippet: string }).snippet).toContain('3→L3')

    expect(patch(p, '@@\n-L3\n+X3')).toEqual({ result: true })
    // The old text is gone from what the model has been shown.
    expect(patch(p, '@@\n-l3\n+X3').result).toBe(false)
  })
})

describe('S8 — Read(range), then a touch with identical bytes', () => {
  test('no attachment, no refusal, and the coverage survives', async () => {
    // `bun run build` preprocesses ~250 source files in place and restores
    // them: same bytes, new mtime. 4 refusals this week were this.
    const p = join(dir, 's8.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })
    const before = ctx.readFileState.get(p)!.timestamp

    touchAhead(p)
    expect(await watcherPass()).toEqual([])

    expect(ctx.readFileState.get(p)!.timestamp).toBeGreaterThan(before)
    expect(patch(p, '@@\n-l3\n+L3')).toEqual({ result: true })
  })
})

describe('S9 — two ranges, one of them rewritten', () => {
  test('the untouched slice keeps its coverage, the changed one is replaced', async () => {
    const p = join(dir, 's9.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })
    await read(p, { offset: 40, limit: 6 })

    rewriteAhead(p, linesWith(60, { 42: 'L42' }))
    const attachments = await watcherPass()
    expect(attachments).toHaveLength(1)
    expect((attachments[0] as { snippet: string }).snippet).toContain('42→L42')

    // l1-l10 still describe the file, so they still authorize a write there.
    expect(patch(p, '@@\n-l3\n+L3')).toEqual({ result: true })
    // The rewritten slice is what the model now holds for 40-45.
    expect(patch(p, '@@\n-L42\n+X42')).toEqual({ result: true })
    // And the refusal for the gap still names both slices.
    expect(refusal(patch(p, '@@\n-l20\n+L20'))).toContain('lines 1-10, 40-45')
  })
})

describe('S10 — a write, a watcher pass, then a new Read', () => {
  test('the file the model just wrote is not the one the cache evicts', async () => {
    // 16 "has not been read yet" refusals this week were on a file the model
    // had just written. The watcher iterated `keys()` (MRU → LRU) and called
    // `get()` on each, which lru-cache treats as a use — so every pass
    // reversed the recency order, and the most recent write became the next
    // eviction victim. Past 100 distinct files (4 sessions this week; one had
    // 249) that fired on the next Read of a new file.
    ctx.readFileState = new FileStateCache(3, 10_000_000)
    const older = join(dir, 's10-older.txt')
    const old = join(dir, 's10-old.txt')
    const written = join(dir, 's10-written.txt')
    const fresh = join(dir, 's10-fresh.txt')
    for (const p of [older, old, written, fresh]) writeLines(p, 20)
    await read(older, { offset: 1, limit: 5 })
    await read(old, { offset: 1, limit: 5 })
    // The shape Edit/Write/apply_patch leave behind, and the most recent use.
    ctx.readFileState.set(written, {
      content: linesWith(20, {}),
      timestamp: getFileModificationTime(written),
      offset: undefined,
      limit: undefined,
    })

    await watcherPass()
    await read(fresh, { offset: 1, limit: 5 })

    expect(ctx.readFileState.has(older)).toBe(false)
    expect(patch(written, '@@\n-l3\n+L3')).toEqual({ result: true })
  })
})

describe('S11 — compaction clears the cache, the plan comes back as an attachment', () => {
  test('the plan file counts as read for both write tools', async () => {
    // The plan is excluded from the post-compact file restore on purpose and
    // re-injected verbatim as `plan_file_reference` — but that attachment
    // seeded no readFileState entry, so the model, holding the whole plan in
    // context, had five consecutive Edits of it refused with "has not been
    // read yet" (session 8db7ab9b, right after an auto-compact).
    const p = join(dir, 's11-plan.md')
    const plan = '# Plan\n\n- [ ] step one\n- [ ] step two\n'
    writeFileSync(p, plan)
    await read(p)
    ctx.readFileState.clear()

    const attachment = createPlanAttachmentIfNeeded(undefined, ctx.readFileState, {
      getPlan: () => plan,
      getPlanFilePath: () => p,
    })
    expect(attachment?.attachment).toMatchObject({ type: 'plan_file_reference' })

    expect(patch(p, '@@\n-- [ ] step one\n+- [x] step one')).toEqual({ result: true })
    expect(
      await FileEditTool.validateInput(
        { file_path: p, old_string: '- [ ] step two', new_string: '- [x] step two' },
        ctx,
      ),
    ).toMatchObject({ result: true })
  })
})

describe('S12 — a whole-file entry over the cap changes on disk', () => {
  test('the refusal says the file changed and is too large, not that it was never read', async () => {
    // The successor to S4. Evicting is still right — the entry no longer
    // describes the file — but "has not been read yet" sends the model to
    // `view='full'`, which fails on the same cap (5 such errors this week).
    const p = join(dir, 's12.ts')
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
    expect(await watcherPass()).toEqual([])
    // The pass terminates: a second one does not try to re-read.
    expect(await watcherPass()).toEqual([])

    const message = refusal(patch(p, '@@\n-  return 1\n+  return 2'))
    expect(message).toContain('too large to re-read whole')
    expect(message).not.toContain('has not been read yet')
  })
})

describe('S13 — Read(range) then a patch on the import block', () => {
  test('the refusal carries the lines, and the identical resubmit applies', async () => {
    // 52 of the 102 coverage refusals this week: Grep → Read(range) of the
    // function being changed → one patch touching the body AND the imports.
    // In 50% of them the resubmit after the forced Read was byte-identical.
    // The refusal now serves the region when the hunk's old side matches the
    // file exactly and uniquely, and counts it as read.
    const p = join(dir, 's13.ts')
    const source =
      "import { a } from './a.js'\n" +
      "import { b } from './b.js'\n" +
      '\n' +
      Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`).join('\n') +
      '\n'
    writeFileSync(p, source)
    await read(p, { offset: 20, limit: 5 })

    const body = "@@\n import { a } from './a.js'\n+import { c } from './c.js'\n import { b } from './b.js'"
    const message = refusal(patch(p, body))
    expect(message).toContain("1→import { a } from './a.js'")
    expect(message).toContain("2→import { b } from './b.js'")

    expect(patch(p, body)).toEqual({ result: true })
  })

  test('a hunk whose old side is not in the file is refused without lines', async () => {
    const p = join(dir, 's13-miss.ts')
    writeLines(p, 30)
    await read(p, { offset: 20, limit: 5 })

    const message = refusal(patch(p, '@@\n-nowhere\n+L1'))
    expect(message).toContain('only read in part')
    expect(message).not.toContain('→')
  })
})

describe('S14 — after a refresh, a re-Read returns the body', () => {
  test('the dedup stub does not point the model at content it never received', async () => {
    // Green before item 2 (a skipped entry keeps its old mtime, so the
    // re-Read is a plain read) and load-bearing after it: a refreshed range
    // entry carries the NEW mtime, which is exactly what the dedup gate
    // compares, and the `file_unchanged` stub would point at the OLD slice in
    // the transcript.
    const p = join(dir, 's14.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })

    rewriteAhead(p, linesWith(60, { 3: 'L3' }))
    await watcherPass()

    const result = await FileReadTool.call(
      { file_path: p, offset: 1, limit: 10 } as never,
      ctx,
    )
    expect(result.data.type).toBe('text')
  })
})

describe('S15 — outline, then Read(range), then a patch outside the range', () => {
  test('the outline does not count as having seen the whole file', async () => {
    // Found while building the served-region refusal: `carrySeenRanges` took
    // the outline entry's `content` (the raw source, no offset) as a slice at
    // line 1, so after outline → Read(range) the coverage lane treated every
    // line as read and a patch anywhere passed. Presence is not coverage.
    const p = join(dir, 's15.ts')
    writeFileSync(
      p,
      Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n',
    )
    await read(p, { view: 'outline' })
    await read(p, { offset: 30, limit: 5 })

    expect(patch(p, '@@\n-export const v31 = 31\n+export const v31 = 0')).toEqual({
      result: true,
    })
    const message = refusal(patch(p, '@@\n-export const v3 = 3\n+export const v3 = 0'))
    expect(message).toContain('only read in part (lines 30-34)')
  })
})

type ReadCredit = typeof import('src/tools/BashTool/creditShownFiles.js')

/**
 * CLAUDIN_BASH_READ_CREDIT is read once at module load, so the scenario loads
 * its own instance of the module with the variable set, and puts it back.
 */
async function loadReadCredit(): Promise<ReadCredit> {
  const prior = process.env.CLAUDIN_BASH_READ_CREDIT
  process.env.CLAUDIN_BASH_READ_CREDIT = '1'
  try {
    return await import(`src/tools/BashTool/creditShownFiles.js?s16=${Date.now()}`)
  } finally {
    if (prior === undefined) delete process.env.CLAUDIN_BASH_READ_CREDIT
    else process.env.CLAUDIN_BASH_READ_CREDIT = prior
  }
}

describe('S16 — a `cat` credited as a read, then a patch', () => {
  test('the patch applies, and a change on disk after the cat still refuses it', async () => {
    const credit = await loadReadCredit()
    const p = join(dir, 's16.txt')
    writeLines(p, 20)
    // Written before the `cat` ran: the credit refuses a file dated at or
    // after the command's start, which a write in this same millisecond is.
    const beforeTheCat = new Date(Date.now() - 60_000)
    utimesSync(p, beforeTheCat, beforeTheCat)
    // No refusal first to prove the file is unread: a refused patch serves
    // its region and registers it, which would authorize the patch below.
    expect(ctx.readFileState.has(p)).toBe(false)

    // What BashTool hands the model for `cat s16.txt`, in a session whose
    // working directories hold the file.
    const startedAt = Date.now()
    const stdout = readFileSync(p, 'utf8').trimEnd()
    expect(
      await credit.creditShownFiles(
        { command: 'cat s16.txt', startedAt, stdout },
        ctx.readFileState,
        dir,
        {
          ...getEmptyToolPermissionContext(),
          additionalWorkingDirectories: new Map([[dir, { path: dir, source: 'session' }]]),
        },
      ),
    ).toEqual([p])
    // The entry a whole-file Read of the same bytes writes, plus dedupExempt:
    // no Read tool_result carries these bytes for a dedup stub to point at.
    const readCtx = makeContext()
    await FileReadTool.call({ file_path: p } as never, readCtx)
    expect(ctx.readFileState.get(p)).toEqual({
      ...readCtx.readFileState.get(p)!,
      dedupExempt: true,
    })
    expect(patch(p, '@@\n-l12\n+L12')).toEqual({ result: true })

    rewriteAhead(p, linesWith(20, { 7: 'L7' }))
    expect(refusal(patch(p, '@@\n-l12\n+L12'))).toContain(
      'has been modified since it was read',
    )
  })
})

describe('S17 — a refused patch resubmitted by reference', () => {
  test('the tool resolves the sentinel to the kept patch, which then applies', async () => {
    // `a` was Read; `b` was only printed by a capped `cat`, so the Read tool never saw it.
    const a = join(dir, 's17-a.txt')
    const b = join(dir, 's17-b.txt')
    writeLines(a, 12)
    writeLines(b, 12)
    await read(a)
    const sent = {
      patchText:
        `*** Begin Patch\n*** Update File: ${a}\n@@\n-l3\n+L3\n` +
        `*** Update File: ${b}\n@@\n-l9\n+L9\n*** End Patch`,
    }
    // The order toolExecution runs them in: resolveInput, then validateInput.
    expect(ApplyPatchTool.resolveInput!(sent, ctx)).toEqual({ ok: true, input: sent })
    const refused = await ApplyPatchTool.validateInput!(sent, ctx)
    expect(refused.result).toBe(false)
    if (!refused.result) {
      expect(refused.message).toContain('has not been read yet')
      expect(refused.message).toContain('9→l9')
      expect(refused.message).toContain(`"${RESUBMIT_SENTINEL}"`)
    }

    const resolved = ApplyPatchTool.resolveInput!({ patchText: RESUBMIT_SENTINEL }, ctx)
    expect(resolved).toEqual({ ok: true, input: sent })
    if (!resolved.ok) return
    expect(await ApplyPatchTool.validateInput!(resolved.input, ctx)).toEqual({ result: true })
    await ApplyPatchTool.call(resolved.input, ctx, (async () => ({ behavior: 'allow' })) as never, {
      uuid: randomUUID(),
    } as never)
    expect(readFileSync(a, 'utf8')).toContain('L3')
    expect(readFileSync(b, 'utf8')).toContain('L9')
  })
})
