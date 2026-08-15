// The auto-outline pivot is behind a build-time flag that the test preload
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileState,
} from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import {
  READ_AUTO_OUTLINE_THRESHOLD_CHARS,
  READ_AUTO_OUTLINE_THRESHOLD_LINES,
} from 'src/tools/FileReadTool/outlineView.js'
import { refreshChangedFile } from 'src/agent/attachments/changedFile.js'

// ---------------------------------------------------------------------------
// The changed-files watcher used to hand its re-read to FileReadTool with no
// `view`, i.e. as a vanilla Read — which for a code file over ~10 KB returns a
// structural outline. Two silent effects, both covered here:
//
//   - the outline's cache entry is `isPartialView: true`, so a file the model
//     had seen in FULL was downgraded, and its next Edit/apply_patch refused
//     with "only been seen as an outline or a partial view";
//   - an outline result matches neither the 'text' nor the 'image' arm, so the
//     function returned null and the model was never told the file changed.
//
// Measured over 683 sessions: 38 of the 50 partial-view refusals on a path the
// session had already read had an out-of-band rewrite (a build, a `perl -i`, a
// `git checkout`) between the read and the refusal.
// ---------------------------------------------------------------------------

/**
 * The auto-outline pivot is behind a build-time flag the test preload stubs to
 * `false`; without forcing it on, the big-file cases below cannot reach the
 * branch that caused the bug and would pass with the fix reverted.
 *
 * Set here rather than at module scope, and restored, because module-scope
 * `process.env` writes leak to every file that runs after this one — the whole
 * suite, since bun runs one process. An earlier version of this file set them
 * at the top and broke 16 tests in four unrelated suites (see
 * .claudin/rules/testing.md on cross-file leaks). Both flags are read at call
 * time, so `beforeAll` is early enough.
 */
const FLAGS = [
  'CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION',
  'CLAUDIN_DISABLE_TOOL_RESULT_CACHE',
] as const
const priorFlags = new Map<string, string | undefined>()

let dir: string

beforeAll(() => {
  for (const flag of FLAGS) {
    priorFlags.set(flag, process.env[flag])
    process.env[flag] = '1'
  }
  dir = mkdtempSync(join(tmpdir(), 'changed-file-'))
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
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    fileReadingLimits,
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

/** Well past READ_AUTO_OUTLINE_THRESHOLD_CHARS and MIN_SYMBOLS (3). */
function bigSource(marker: string): string {
  const fns = Array.from(
    { length: 60 },
    (_, i) =>
      `export function fn${i}(): string {\n` +
      `  // ${marker} ${'padding '.repeat(40)}\n` +
      `  return '${marker}-${i}'\n}\n`,
  )
  return fns.join('\n')
}

test('the fixture actually crosses the auto-outline threshold', () => {
  // Without this the big-file cases are tautologies: an earlier version of the
  // fixture came to ~9,079 chars and 199 lines, under BOTH triggers, so every
  // assertion below passed with `view: 'full'` deleted. Pinned against the
  // constants so the fixture cannot drift back under them.
  const source = bigSource('BEFORE')
  expect(source.length).toBeGreaterThanOrEqual(
    READ_AUTO_OUTLINE_THRESHOLD_CHARS,
  )
  expect(source.split('\n').length).toBeGreaterThanOrEqual(
    READ_AUTO_OUTLINE_THRESHOLD_LINES,
  )
})

/** Write `content` and force the mtime forward so the watcher sees a change. */
function writeAhead(path: string, content: string, secondsAhead = 10): void {
  writeFileSync(path, content)
  const when = new Date(Date.now() + secondsAhead * 1000)
  utimesSync(path, when, when)
}

/** The entry an Edit/Write/apply_patch leaves behind: whole file, no offset. */
function postWriteEntry(content: string, timestamp: number): FileState {
  return { content, timestamp, offset: undefined, limit: undefined }
}

describe('refreshChangedFile', () => {
  test('a large code file that changed produces a snippet, not silence', () => {
    // With the vanilla Read this returned null: the pivot answered with an
    // outline, which is neither 'text' nor 'image'.
    const p = join(dir, 'big.ts')
    const before = bigSource('BEFORE')
    writeFileSync(p, before)
    const seeded = getFileModificationTime(p)
    const ctx = makeContext()
    ctx.readFileState.set(p, postWriteEntry(before, seeded))

    writeAhead(p, bigSource('AFTER'))

    return refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx).then(
      attachment => {
        expect(attachment).not.toBeNull()
        expect(attachment!.type).toBe('edited_text_file')
      },
    )
  })

  test('and leaves the entry editable instead of downgrading it', async () => {
    // The refusal half. An outline entry is isPartialView, so the four write
    // tools refuse the file the model had read in full.
    const p = join(dir, 'big-editable.ts')
    const before = bigSource('BEFORE')
    writeFileSync(p, before)
    const ctx = makeContext()
    ctx.readFileState.set(p, postWriteEntry(before, getFileModificationTime(p)))

    writeAhead(p, bigSource('AFTER'))
    await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx)

    const entry = ctx.readFileState.get(p)!
    expect(entry.isPartialView).toBeUndefined()
    expect(entry.content).toContain('AFTER')
  })

  test('and keeps it eligible for the NEXT external change', async () => {
    // getChangedFiles skips any entry with an offset, and a full Read writes
    // offset 1. Without the normalization the first refresh would quietly
    // retire this file from change detection for the rest of the session.
    const p = join(dir, 'big-twice.ts')
    writeFileSync(p, bigSource('V1'))
    const ctx = makeContext()
    ctx.readFileState.set(
      p,
      postWriteEntry(bigSource('V1'), getFileModificationTime(p)),
    )

    writeAhead(p, bigSource('V2'), 10)
    const first = await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx)
    expect(first).not.toBeNull()

    const entry = ctx.readFileState.get(p)!
    expect(entry.offset).toBeUndefined()
    expect(entry.limit).toBeUndefined()

    writeAhead(p, bigSource('V3'), 20)
    const second = await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx)
    expect(second).not.toBeNull()
  })

  test('a small file behaves exactly as before', async () => {
    const p = join(dir, 'small.ts')
    writeFileSync(p, 'const a = 1\n')
    const ctx = makeContext()
    ctx.readFileState.set(
      p,
      postWriteEntry('const a = 1\n', getFileModificationTime(p)),
    )

    writeAhead(p, 'const a = 2\n')
    const attachment = await refreshChangedFile(
      p,
      p,
      ctx.readFileState.get(p)!,
      ctx,
    )

    expect(attachment).toMatchObject({ type: 'edited_text_file' })
  })

  test('an untouched file yields nothing and is left alone', async () => {
    const p = join(dir, 'untouched.ts')
    writeFileSync(p, 'const a = 1\n')
    const ctx = makeContext()
    const entry = postWriteEntry('const a = 1\n', getFileModificationTime(p))
    ctx.readFileState.set(p, entry)

    expect(await refreshChangedFile(p, p, entry, ctx)).toBeNull()
    expect(ctx.readFileState.get(p)).toBe(entry)
  })

  test('a file that grew past the read cap is evicted, and stays evicted', async () => {
    // `view: 'full'` rethrows where a vanilla Read served an outline, and the
    // outline at least refreshed the timestamp. Doing nothing here would leave
    // mtime > timestamp true and retry this read on every single turn. Evicting
    // ends it: no entry, nothing for the watcher to walk.
    const p = join(dir, 'overcap.ts')
    const before = bigSource('BEFORE')
    writeFileSync(p, before)
    const ctx = makeContext({ maxSizeBytes: 512, maxTokens: 25_000 })
    ctx.readFileState.set(p, postWriteEntry(before, getFileModificationTime(p)))

    writeAhead(p, bigSource('AFTER'))
    const attachment = await refreshChangedFile(
      p,
      p,
      ctx.readFileState.get(p)!,
      ctx,
    )

    expect(attachment).toBeNull()
    expect(ctx.readFileState.has(p)).toBe(false)
  })

  test('a deleted file is evicted', async () => {
    const p = join(dir, 'gone.ts')
    writeFileSync(p, 'const a = 1\n')
    const ctx = makeContext()
    const entry = postWriteEntry('const a = 1\n', getFileModificationTime(p))
    ctx.readFileState.set(p, entry)
    unlinkSync(p)

    expect(await refreshChangedFile(p, p, entry, ctx)).toBeNull()
    expect(ctx.readFileState.has(p)).toBe(false)
  })
})
