// The auto-outline pivot is behind a build-time flag the test preload stubs to
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
  type ValidationResult,
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
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { createPlanAttachmentIfNeeded } from 'src/agent/compact/postCompactAttachments.js'
import {
  getChangedFileAttachments,
  refreshChangedFile,
} from 'src/agent/attachments/changedFile.js'

// ---------------------------------------------------------------------------
// End-to-end read-gate scenarios: the real Read tool writes the cache entry,
// and a real write tool's validator reads it. Everything else in this area is
// unit-tested against a HAND-SEEDED entry, which is precisely how both of these
// bugs survived — a fabricated entry cannot show that Read wrote the wrong one.
//
// They observe through Write, the whole-file write, which keeps the full gate.
// Patch (2026-09-24) and Edit (2026-10-12) write in place and only ask whether
// the file was read at all (S19, S20), so a scenario about coverage, a partial
// view or a stale entry passes through them unobserved; where they still
// appear it is to show that they do take it. The ones left on Patch — S10,
// S11, S16, S17, S18 — are about the entry being there.
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
// a refusal that had already served the lines it needed (`*** Resubmit` until
// 2026-09-29):
//   S17 a patch on a file only `cat`'d applies when its hunks match exactly
//
// And from its proxy logs, where the watcher told the model 53 times in 16 of
// 30 sessions that a file it had just written was "modified by the user":
//   S18 a write, then the same bytes rewritten                    (`git stash` + `pop`)
//
// And the policy that replaced Patch's gate on 2026-09-24:
//   S19 an outline, a range, a file changed since: any read authorizes a patch
// And Edit's, on 2026-10-12, after the census of 2026-10-05..12:
//   S20 the same for Edit, and a file never read edited when old_string sits in it once
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
  // S20 runs Edit's call(), which would back files up under the config dir.
  'CLAUDIN_DISABLE_FILE_CHECKPOINTING',
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

/** Edit's validator: an in-place write, which takes any read (S20). */
function edit(path: string, oldString: string, newString: string) {
  return FileEditTool.validateInput(
    { file_path: path, old_string: oldString, new_string: newString },
    ctx,
  )
}

/** Write's validator: a whole-file write, which needs the file read whole and unchanged. */
function write(path: string, content = 'replaced\n') {
  return FileWriteTool.validateInput({ file_path: path, content }, ctx)
}

function refusal(result: ValidationResult): string {
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
  test('an edit inside the FIRST range is authorized', async () => {
    // Before the accumulation the entry stood for the last Read alone, so this
    // was refused with "only read in part (lines 40-45)" — naming lines the
    // model was holding while claiming it had not seen l3.
    const p = join(dir, 's1-first.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })
    await read(p, { offset: 40, limit: 6 })

    expect(await edit(p, 'l3\n', 'L3\n')).toMatchObject({ result: true })
  })

  test('Write is refused, naming both ranges and not the gap', async () => {
    // The refusal names everything the model has been shown. Concatenating
    // the slices instead of merging them by line number would name one range.
    const p = join(dir, 's1-write.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })
    await read(p, { offset: 40, limit: 6 })

    expect(refusal(await write(p))).toContain('was only read in part (lines 1-10, 40-45)')
  })
})

describe('S2 — a narrow Read landing on a full one', () => {
  test('the full read still authorizes an edit elsewhere in the file', async () => {
    // The clobber: 561 whole-file entries in the corpus were destroyed this
    // way. The model reads a file, then reads eight lines of it to re-check
    // something, and its next write is refused.
    const p = join(dir, 's2.txt')
    writeLines(p, 60)
    await read(p)
    await read(p, { offset: 40, limit: 6 })

    expect(await edit(p, 'l3\n', 'L3\n')).toMatchObject({ result: true })
    // And for Write, which needs every line: the full read still holds them.
    expect(await write(p)).toEqual({ result: true })
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

  test('the model is told, and can still edit the file', async () => {
    const p = join(dir, 's3.ts')
    writeFileSync(p, bigSource('BEFORE'))
    // The shape Edit/Write/Patch leave behind: whole file, no offset.
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
    expect(
      await edit(p, "  return 'AFTER0'\n", "  return 'PATCHED'\n"),
    ).toMatchObject({ result: true })
    // The refreshed entry is the whole new file, at its new mtime.
    expect(await write(p)).toEqual({ result: true })
  })
})

describe('S4 — the rewritten file can no longer be re-read', () => {
  test('the stale entry stops vouching for the file, and the next Write is refused', async () => {
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

    expect((await write(p)).result).toBe(false)
    // An in-place edit is matched against the file as it is now.
    expect(await edit(p, '  return 1\n', '  return 2\n')).toMatchObject({ result: true })
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

    // The refusal describes only what is still true.
    expect(refusal(await write(p))).toContain('was only read in part (lines 40-45)')
  })
})

describe('S6 — Read(range), then the file changes outside the range', () => {
  test('the watcher refreshes the entry and an edit inside the range passes', async () => {
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
    expect(await edit(p, 'l3\n', 'L3\n')).toMatchObject({ result: true })
  })
})

describe('S7 — Read(range), then the file changes inside the range', () => {
  test('the model is told what changed and can edit the new text', async () => {
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

    expect(await edit(p, 'L3\n', 'X3\n')).toMatchObject({ result: true })
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
    expect(await edit(p, 'l3\n', 'L3\n')).toMatchObject({ result: true })
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
    expect(await edit(p, 'l3\n', 'L3\n')).toMatchObject({ result: true })
    // The rewritten slice is what the model now holds for 40-45.
    expect(await edit(p, 'L42\n', 'X42\n')).toMatchObject({ result: true })
    expect(refusal(await write(p))).toContain('was only read in part (lines 1-10, 40-45)')
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
    // The shape Edit/Write/Patch leave behind, and the most recent use.
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
    expect(await write(p, '# Plan\n')).toEqual({ result: true })
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

    expect(refusal(await write(p))).toContain('too large to re-read whole')
    expect(refusal(await write(p))).not.toContain('has not been read yet')
  })
})

describe('S13 — Read(range) then a patch on the import block', () => {
  /** Two imports, a blank line, then thirty consts: lines 20-24 miss the imports. */
  const source =
    "import { a } from './a.js'\n" +
    "import { b } from './b.js'\n" +
    '\n' +
    Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`).join('\n') +
    '\n'

  test('Patch takes it as sent: a Read of the range is a read of the file', async () => {
    // 52 of the 102 coverage refusals in the 2026-09-14..20 census: Grep →
    // Read(range) of the function being changed → one patch touching the body
    // AND the imports. In 50% of them the resubmit after the forced Read was
    // byte-identical, so since 2026-09-24 there is no refusal to answer.
    const p = join(dir, 's13.ts')
    writeFileSync(p, source)
    await read(p, { offset: 20, limit: 5 })

    const body = "@@\n import { a } from './a.js'\n+import { c } from './c.js'\n import { b } from './b.js'"
    expect(patch(p, body)).toEqual({ result: true })
  })

  test('Edit takes it as sent too', async () => {
    const p = join(dir, 's13-edit.ts')
    writeFileSync(p, source)
    await read(p, { offset: 20, limit: 5 })

    const oldString = "import { a } from './a.js'\nimport { b } from './b.js'\n"
    const newString =
      "import { a } from './a.js'\nimport { c } from './c.js'\nimport { b } from './b.js'\n"
    expect(await edit(p, oldString, newString)).toMatchObject({ result: true })
  })

  test('an Edit needle that is not in the file is refused for that, not for the read', async () => {
    const p = join(dir, 's13-miss.ts')
    writeLines(p, 30)
    await read(p, { offset: 20, limit: 5 })

    const message = refusal(await edit(p, 'nowhere', 'L1'))
    expect(message).toStartWith('String to replace not found in file.')
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

describe('S15 — outline, then Read(range), then a write outside the range', () => {
  test('the outline does not count as having seen the whole file', async () => {
    // Found while building the served-region refusal: `carrySeenRanges` took
    // the outline entry's `content` (the raw source, no offset) as a slice at
    // line 1, so after outline → Read(range) every line counted as read and a
    // Write passed. Presence is not coverage — for Write; Patch and Edit take
    // the outline alone (S19, S20).
    const p = join(dir, 's15.ts')
    writeFileSync(
      p,
      Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n',
    )
    await read(p, { view: 'outline' })
    await read(p, { offset: 30, limit: 5 })

    expect(
      await edit(p, 'export const v31 = 31\n', 'export const v31 = 0\n'),
    ).toMatchObject({ result: true })
    expect(refusal(await write(p))).toContain('was only read in part (lines 30-34)')
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
  test('the patch applies, and Write refuses the bytes once they change on disk', async () => {
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
      (
        await credit.creditShownFiles(
          { command: 'cat s16.txt', startedAt, stdout },
          ctx.readFileState,
          dir,
          {
            ...getEmptyToolPermissionContext(),
            additionalWorkingDirectories: new Map([[dir, { path: dir, source: 'session' }]]),
          },
        )
      ).credited,
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
    // Patch and Edit match at apply time (S19, S20); the credit is dated to
    // the cat all the same, which is what Write's staleness check reads.
    expect(refusal(await write(p))).toContain('modified since read')
    expect(await edit(p, 'l12\n', 'L12\n')).toMatchObject({ result: true })
  })
})

describe('S17 — a patch on a file only `cat`ed applies when its hunks match exactly', () => {
  test('the file never Read is patched in the same call as the one that was', async () => {
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
    expect(await ApplyPatchTool.resolveInput!(sent, ctx)).toEqual({ ok: true, input: sent })
    expect(await ApplyPatchTool.validateInput!(sent, ctx)).toEqual({ result: true })
    const done = await ApplyPatchTool.call(sent, ctx, (async () => ({ behavior: 'allow' })) as never, {
      uuid: randomUUID(),
    } as never)
    expect(readFileSync(a, 'utf8')).toContain('L3')
    expect(readFileSync(b, 'utf8')).toContain('L9')
    // The model is told the file was patched unread, and a later Edit finds it read.
    expect(done.data.appliedUnread).toEqual([expect.stringContaining('s17-b.txt')])
    expect(ctx.readFileState.get(b)).toBeDefined()
  })
})

describe('S18 — a write, then the same bytes rewritten', () => {
  async function patchApplied(p: string, body: string): Promise<void> {
    const input = { patchText: `*** Begin Patch\n*** Update File: ${p}\n${body}\n*** End Patch` }
    expect(await ApplyPatchTool.validateInput!(input, ctx)).toEqual({ result: true })
    await ApplyPatchTool.call(input, ctx, (async () => ({ behavior: 'allow' })) as never, {
      uuid: randomUUID(),
    } as never)
  }

  test('no note that the user changed the file the model just wrote', async () => {
    // `git stash && bun test …; git stash pop` — the model checking that its
    // new test fails without the fix — puts every patched file back byte for
    // byte with a new mtime.
    const p = join(dir, 's18.txt')
    writeLines(p, 30)
    await read(p)
    await patchApplied(p, '@@\n-l5\n+L5')
    rewriteAhead(p, readFileSync(p, 'utf8'))
    expect(await watcherPass()).toEqual([])
    expect(patch(p, '@@\n-l12\n+L12')).toEqual({ result: true })
  })

  test('a real change after the write is still reported, and only that change', async () => {
    const p = join(dir, 's18-real.txt')
    writeLines(p, 30)
    await read(p)
    await patchApplied(p, '@@\n-l5\n+L5')
    rewriteAhead(p, readFileSync(p, 'utf8').replace('l7\n', 'L7\n'))
    const attachments = await watcherPass()
    expect(attachments).toHaveLength(1)
    const snippet = (attachments[0] as { snippet: string }).snippet
    expect(snippet).toContain('7→L7')
    expect(snippet).not.toContain('30→l30')
  })
})

describe('S19 — Patch takes any read', () => {
  // applyPatch.ts, "Read gate": the entry only has to exist. What stops a wrong
  // hunk is the patch itself, matched against the file on disk when it lands.
  async function apply(p: string, body: string): Promise<void> {
    const input = { patchText: `*** Begin Patch\n*** Update File: ${p}\n${body}\n*** End Patch` }
    await ApplyPatchTool.call(input, ctx, (async () => ({ behavior: 'allow' })) as never, {
      uuid: randomUUID(),
    } as never)
  }

  test('an outline alone authorizes a patch anywhere in the file', async () => {
    const p = join(dir, 's19-outline.ts')
    writeFileSync(
      p,
      Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n',
    )
    await read(p, { view: 'outline' })
    // Without this the test proves nothing: a full entry would pass anyway.
    expect(ctx.readFileState.get(p)!.isPartialView).toBe(true)

    const body = '@@\n-export const v3 = 3\n+export const v3 = 0'
    expect(patch(p, body)).toEqual({ result: true })
    await apply(p, body)
    expect(readFileSync(p, 'utf8')).toContain('\nexport const v3 = 0\n')
  })

  test('a range read authorizes a patch outside the range', async () => {
    const p = join(dir, 's19-range.txt')
    writeLines(p, 60)
    await read(p, { offset: 1, limit: 10 })

    const body = '@@\n-l50\n+L50'
    expect(patch(p, body)).toEqual({ result: true })
    await apply(p, body)
    expect(readFileSync(p, 'utf8')).toContain('\nL50\n')
  })

  test('a file changed on disk since the read is patched as it is now', async () => {
    // No watcher pass in between: the entry still describes the old bytes.
    const p = join(dir, 's19-changed.txt')
    writeLines(p, 30)
    await read(p)
    rewriteAhead(p, linesWith(30, { 7: 'L7' }))

    const body = '@@\n-l12\n+L12'
    expect(patch(p, body)).toEqual({ result: true })
    await apply(p, body)
    // The change made after the read survives: the hunk named l12 only.
    expect(readFileSync(p, 'utf8')).toBe(linesWith(30, { 7: 'L7', 12: 'L12' }))
  })

  test('a hunk that no longer matches is refused when applied, and writes nothing', async () => {
    const p = join(dir, 's19-mismatch.txt')
    writeLines(p, 30)
    await read(p)
    rewriteAhead(p, linesWith(30, { 12: 'L12' }))

    const body = '@@\n-l12\n+X12'
    expect(patch(p, body)).toEqual({ result: true })
    await expect(apply(p, body)).rejects.toThrow('Failed to find expected lines')
    expect(readFileSync(p, 'utf8')).toBe(linesWith(30, { 12: 'L12' }))
  })

  test('a file never read is refused when a hunk does not match it exactly', () => {
    // One that does match exactly is patched unread since 2026-09-29 (S17).
    const p = join(dir, 's19-never.txt')
    writeLines(p, 30)
    expect(refusal(patch(p, '@@\n-l99\n+L99'))).toContain('has not been read yet')
  })
})

describe('S20 — Edit takes any read, like Patch', () => {
  // FileEditTool.ts and readBeforeEditMessages.ts, "In-place writes". In the
  // 2026-10-05..12 census 19 of Edit's 22 errors were its own read lanes, every
  // one an exact match, and 14 came back byte-identical.
  async function applied(p: string, oldString: string, newString: string) {
    const input = { file_path: p, old_string: oldString, new_string: newString }
    expect(await FileEditTool.validateInput(input, ctx)).toMatchObject({ result: true })
    return (await FileEditTool.call(input, ctx, undefined as never, { uuid: randomUUID() } as never)).data
  }

  test('an outline alone authorizes an edit anywhere in the file', async () => {
    const p = join(dir, 's20-outline.ts')
    writeFileSync(
      p,
      Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n',
    )
    await read(p, { view: 'outline' })
    expect(ctx.readFileState.get(p)!.isPartialView).toBe(true)

    await applied(p, 'export const v3 = 3\n', 'export const v3 = 0\n')
    expect(readFileSync(p, 'utf8')).toContain('\nexport const v3 = 0\n')
  })

  test('a range read to the end of the file: an old_string ending with its last newline applies', async () => {
    // floor.test.ts, refused twice in a row: the old coverage lane compared
    // the needle with the slice joined without its final newline.
    const p = join(dir, 's20-eof.txt')
    writeLines(p, 30)
    await read(p, { offset: 21, limit: 10 })

    await applied(p, 'l29\nl30\n', 'l29\nl30\nl31\n')
    expect(readFileSync(p, 'utf8')).toEndWith('l30\nl31\n')
  })

  test('a file changed on disk since the read is edited as it is now', async () => {
    const p = join(dir, 's20-changed.txt')
    writeLines(p, 30)
    await read(p)
    rewriteAhead(p, linesWith(30, { 7: 'L7' }))

    await applied(p, 'l12\n', 'L12\n')
    expect(readFileSync(p, 'utf8')).toBe(linesWith(30, { 7: 'L7', 12: 'L12' }))
  })

  test('a file never read is edited when old_string sits in it once, and refused otherwise', async () => {
    const p = join(dir, 's20-never.txt')
    writeLines(p, 30)
    expect(refusal(await edit(p, 'l1', 'L1'))).toContain('old_string occurs in it 11 times') // l1, l10..l19
    const data = await applied(p, 'l25\n', 'L25\n')
    expect(data.unread).toBe(true)
    // Written once, it counts as read: the next edit needs no exact match.
    expect(await edit(p, 'l1', 'L1')).toMatchObject({ result: false }) // still ambiguous, now for the match
    expect(refusal(await edit(p, 'l1', 'L1'))).toStartWith('Found ')
  })
})
