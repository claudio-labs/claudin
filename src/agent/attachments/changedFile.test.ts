// The auto-outline pivot is behind a build-time flag that the test preload
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  FileStateCache,
  READ_FILE_STATE_CACHE_SIZE,
  type FileState,
} from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import {
  READ_AUTO_OUTLINE_THRESHOLD_CHARS,
  READ_AUTO_OUTLINE_THRESHOLD_LINES,
} from 'src/tools/FileReadTool/outlineView.js'
import {
  changedFileCandidates,
  getChangedFileAttachments,
  refreshChangedFile,
} from 'src/agent/attachments/changedFile.js'
import {
  type FileChangingTool,
  settleOwnWrites,
} from 'src/agent/attachments/ownWrites.js'

// ---------------------------------------------------------------------------
// The changed-files watcher used to hand its re-read to FileReadTool with no
// `view`, i.e. as a vanilla Read — which for a code file over ~10 KB returns a
// structural outline. Two silent effects, both covered here:
//
//   - the outline's cache entry is `isPartialView: true`, so a file the model
//     had seen in FULL was downgraded, and its next Edit/Patch refused
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

/** The entry an Edit/Write/Patch leaves behind: whole file, no offset. */
function postWriteEntry(content: string, timestamp: number): FileState {
  return { content, timestamp, offset: undefined, limit: undefined }
}

/** `count` lines `l1..lN`, with the given ones replaced. */
function numbered(count: number, replace: Record<number, string> = {}): string {
  return (
    Array.from({ length: count }, (_, i) => replace[i + 1] ?? `l${i + 1}`).join(
      '\n',
    ) + '\n'
  )
}

/** The entry a Read(offset, limit) leaves behind. */
function rangeEntry(
  path: string,
  offset: number,
  limit: number,
  seenRanges?: FileState['seenRanges'],
): FileState {
  const lines = readFileSync(path, 'utf8').split('\n')
  return {
    content: `${lines.slice(offset - 1, offset - 1 + limit).join('\n')}\n`,
    timestamp: getFileModificationTime(path),
    offset,
    limit,
    seenRanges,
  }
}

describe('changedFileCandidates', () => {
  test('a pass does not change which entry the cache evicts next', () => {
    // lru-cache counts `get()` as a use and `keys()` yields MRU → LRU, so a
    // pass built on the two reversed the recency order every time it ran: the
    // entry the model had just written became the least recent, and the next
    // Read of a new file evicted it. 16 "has not been read yet" refusals on a
    // just-written file in one week (tool-error-census-2026-09-20.md).
    const cache = new FileStateCache(3, 1024 * 1024)
    cache.set('/a', postWriteEntry('a', 1))
    cache.set('/b', postWriteEntry('b', 2))
    cache.set('/c', postWriteEntry('c', 3))

    const visited = changedFileCandidates(cache).map(([key]) => key)
    expect(visited).toEqual(['/c', '/b', '/a'])

    cache.set('/d', postWriteEntry('d', 4))
    expect(cache.has('/c')).toBe(true)
    expect(cache.has('/a')).toBe(false)
  })
})

describe('refreshChangedFile', () => {
  describe('a range entry', () => {
    test('is refreshed in place when the file changes outside the slice', async () => {
      // The watcher used to skip every entry with an offset, so a file the
      // model had only READ was never refreshed after a `sed -i`, a build
      // touch or a sub-agent edit — 30 "modified since read" refusals in the
      // 2026-09-14..20 corpus, all on such entries.
      const p = join(dir, 'range-outside.txt')
      writeFileSync(p, numbered(60))
      const ctx = makeContext()
      ctx.readFileState.set(p, rangeEntry(p, 1, 10))

      writeAhead(p, numbered(60, { 40: 'L40' }))
      const attachment = await refreshChangedFile(
        p,
        p,
        ctx.readFileState.get(p)!,
        ctx,
      )

      expect(attachment).toBeNull()
      const entry = ctx.readFileState.get(p)!
      expect(entry.timestamp).toBe(getFileModificationTime(p))
      expect(entry.offset).toBe(1)
      expect(entry.limit).toBe(10)
      expect(entry.content).toBe(numbered(10))
      expect(entry.dedupExempt).toBe(true)
    })

    test('reports the change with FILE line numbers when the slice itself changed', async () => {
      const p = join(dir, 'range-inside.txt')
      writeFileSync(p, numbered(60))
      const ctx = makeContext()
      ctx.readFileState.set(p, rangeEntry(p, 40, 6))

      writeAhead(p, numbered(60, { 42: 'L42' }))
      const attachment = await refreshChangedFile(
        p,
        p,
        ctx.readFileState.get(p)!,
        ctx,
      )

      expect(attachment).toMatchObject({ type: 'edited_text_file' })
      expect((attachment as { snippet: string }).snippet).toContain('42→L42')
      expect(ctx.readFileState.get(p)!.content).toBe(
        'l40\nl41\nL42\nl43\nl44\nl45\n',
      )
    })

    test('a touch with identical bytes moves the timestamp and nothing else', async () => {
      const p = join(dir, 'range-touch.txt')
      writeFileSync(p, numbered(60))
      const ctx = makeContext()
      const before = rangeEntry(p, 1, 10, [{ offset: 40, content: 'l40\nl41\n' }])
      ctx.readFileState.set(p, before)

      const when = new Date(Date.now() + 10_000)
      utimesSync(p, when, when)
      expect(
        await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx),
      ).toBeNull()

      const entry = ctx.readFileState.get(p)!
      expect(entry.timestamp).toBeGreaterThan(before.timestamp)
      expect(entry.seenRanges).toEqual([{ offset: 40, content: 'l40\nl41\n' }])
    })

    test('keeps the carried slices that still match and drops the ones that do not', async () => {
      const p = join(dir, 'range-carried.txt')
      writeFileSync(p, numbered(60))
      const ctx = makeContext()
      ctx.readFileState.set(
        p,
        rangeEntry(p, 50, 5, [
          { offset: 1, content: 'l1\nl2\nl3\n' },
          { offset: 20, content: 'l20\nl21\n' },
        ]),
      )

      writeAhead(p, numbered(60, { 21: 'L21' }))
      await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx)

      expect(ctx.readFileState.get(p)!.seenRanges).toEqual([
        { offset: 1, content: 'l1\nl2\nl3\n' },
      ])
    })

    test('a deleted file is evicted', async () => {
      const p = join(dir, 'range-gone.txt')
      writeFileSync(p, numbered(10))
      const ctx = makeContext()
      const entry = rangeEntry(p, 2, 3)
      ctx.readFileState.set(p, entry)
      unlinkSync(p)

      expect(await refreshChangedFile(p, p, entry, ctx)).toBeNull()
      expect(ctx.readFileState.has(p)).toBe(false)
    })
  })

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

  test('a file that grew past the read cap becomes a dated marker, and the pass stops retrying', async () => {
    // `view: 'full'` rethrows where a vanilla Read served an outline, and the
    // outline at least refreshed the timestamp. Doing nothing here would leave
    // mtime > timestamp true and retry this read on every single turn. The
    // marker ends it like the eviction it replaced — dated to the new mtime —
    // and keeps the reason for the refusal that follows.
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
    const entry = ctx.readFileState.get(p)!
    expect(entry).toMatchObject({
      content: '',
      isPartialView: true,
      refreshFailed: 'too-large',
      timestamp: getFileModificationTime(p),
    })
    // Dated to the new mtime: the next pass is a no-op, not another re-read.
    expect(await refreshChangedFile(p, p, entry, ctx)).toBeNull()
    expect(ctx.readFileState.get(p)).toBe(entry)
  })

  test('past the TOKEN cap too: the same marker, not a diff against the first page', async () => {
    // A view='full' Read over the token cap answers with its first page
    // (overCapPage.ts). Diffed against the whole file the model had, that
    // page read as every later line deleted, and its entry let Write through.
    const p = join(dir, 'overcap-tokens.ts')
    const before = bigSource('BEFORE')
    writeFileSync(p, before)
    const ctx = makeContext({ maxSizeBytes: 10 * 1024 * 1024, maxTokens: 2_000 })
    ctx.readFileState.set(p, postWriteEntry(before, getFileModificationTime(p)))

    writeAhead(p, before.replace("'BEFORE-59'", "'AFTER-59'"))
    const attachment = await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx)

    expect(attachment).toBeNull()
    expect(ctx.readFileState.get(p)).toMatchObject({
      content: '',
      isPartialView: true,
      refreshFailed: 'too-large',
      timestamp: getFileModificationTime(p),
    })
    const { FileWriteTool } = await import('src/tools/FileWriteTool/FileWriteTool.js')
    const write = await FileWriteTool.validateInput!({ file_path: p, content: 'clobber\n' }, ctx)
    expect(write.result).toBe(false)
  })

  test('a range entry of a file past the refresh cap becomes the same marker', async () => {
    const p = join(dir, 'range-overcap.txt')
    writeFileSync(p, numbered(60))
    const ctx = makeContext()
    ctx.readFileState.set(p, rangeEntry(p, 1, 10))

    // RANGE_REFRESH_MAX_BYTES is 10 MB: one line of 11 MB crosses it.
    writeAhead(p, `${'x'.repeat(11 * 1024 * 1024)}\n${numbered(59)}`)
    expect(
      await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx),
    ).toBeNull()
    expect(ctx.readFileState.get(p)).toMatchObject({
      refreshFailed: 'too-large',
      isPartialView: true,
    })
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

// ---------------------------------------------------------------------------
// A child (a sub-agent, the extract_memories and auto_dream forks) settles its
// writes into its OWN copy of the read state, so the parent's watcher took
// every file a child wrote for an outside edit: 59 "modified, either by the
// user or by a linter" notes in the 2026-11-14..16 census, 248K chars of
// snippet, none of them from the user. The child's settle now records what it
// wrote, and the thread that owns the session gets the names in one note.
//
// The record is process-wide and has no reset a test can reach, so every case
// writes a path of its own.
// ---------------------------------------------------------------------------
describe('a file a child wrote', () => {
  const OWN_WRITES_FLAG = 'CLAUDIN_OWN_WRITES'
  let priorOwnWrites: string | undefined

  beforeEach(() => {
    priorOwnWrites = process.env[OWN_WRITES_FLAG]
    // Unset on purpose: on by default, and the settle is a no-op when off.
    delete process.env[OWN_WRITES_FLAG]
  })
  afterEach(() => {
    if (priorOwnWrites === undefined) delete process.env[OWN_WRITES_FLAG]
    else process.env[OWN_WRITES_FLAG] = priorOwnWrites
  })

  /** The tool loop's settle, called with the `childOf` argument it passes for a context that has an agentId. */
  const settle = settleOwnWrites as (
    ...args: unknown[]
  ) => ReturnType<typeof settleOwnWrites>
  const WRITING_TOOL: FileChangingTool = { isReadOnly: () => false }

  /** A sub-agent's context: an agentId, and its own copy of the parent's read state. */
  function childContext(parent: ToolUseContext): ToolUseContext {
    return {
      ...parent,
      agentId: 'census-child' as ToolUseContext['agentId'],
      readFileState: cloneFileStateCache(parent.readFileState),
    }
  }

  /** The entry and the mtime a child's Write/Edit/Patch leaves behind. Not settled. */
  function childWrites(
    child: ToolUseContext,
    path: string,
    content: string,
    secondsAhead = 10,
  ): void {
    writeAhead(path, content, secondsAhead)
    child.readFileState.set(
      path,
      postWriteEntry(content, getFileModificationTime(path)),
    )
  }

  /** The settle that ends a child's call started at `startedAt`. */
  async function settleAsChild(
    child: ToolUseContext,
    startedAt: number,
  ): Promise<void> {
    await settle(WRITING_TOOL, {}, child.readFileState, startedAt, dir, true)
  }

  /** A pass's attachment types, as the plain strings the renderer switches on. */
  function typesOf(attachments: readonly { type: string }[]): string[] {
    return attachments.map(attachment => attachment.type)
  }

  /** The names carried by the pass's `child_written_files` attachments, one list per attachment. */
  function childWrittenNames(
    attachments: readonly { type: string }[],
  ): string[][] {
    return attachments
      .filter(attachment => attachment.type === 'child_written_files')
      .map(attachment => (attachment as { filenames?: string[] }).filenames ?? [])
  }

  test('a file a child wrote reaches the parent as a name, not a diff', async () => {
    const p = join(dir, 'child-name.ts')
    writeFileSync(p, 'const a = 1\n')
    const parent = makeContext()
    parent.readFileState.set(
      p,
      postWriteEntry('const a = 1\n', getFileModificationTime(p)),
    )

    const child = childContext(parent)
    const startedAt = Date.now()
    childWrites(child, p, 'const a = 2\n')
    await settleAsChild(child, startedAt)

    const attachments = await getChangedFileAttachments(parent)

    expect(typesOf(attachments)).not.toContain('edited_text_file')
    expect(childWrittenNames(attachments)).toEqual([[p]])
    expect(attachments).toHaveLength(1)
    const entry = parent.readFileState.get(p)!
    expect(entry.content).toContain('const a = 2')
    expect(entry.timestamp).toBe(getFileModificationTime(p))
  })

  test('two files written by children in one pass share one attachment', async () => {
    // Set z-first so neither the cache's order nor the write order is the
    // sorted one. The first is a child's direct Write; the second a file the
    // child had read and then changed through Bash, which its settle adopts.
    const written = join(dir, 'child-pair-z-written.ts')
    const viaBash = join(dir, 'child-pair-a-bash.ts')
    const parent = makeContext()
    for (const p of [written, viaBash]) {
      writeFileSync(p, 'const a = 1\n')
      parent.readFileState.set(
        p,
        postWriteEntry('const a = 1\n', getFileModificationTime(p)),
      )
    }

    const child = childContext(parent)
    const startedAt = Date.now()
    childWrites(child, written, 'const a = 2\n')
    writeAhead(viaBash, 'const a = 2\n')
    await settleAsChild(child, startedAt)

    const attachments = await getChangedFileAttachments(parent)

    expect(typesOf(attachments)).not.toContain('edited_text_file')
    expect(childWrittenNames(attachments)).toEqual([[viaBash, written]])
    expect(attachments).toHaveLength(1)
  })

  test('a range entry of the parent is brought up to date without a snippet', async () => {
    const p = join(dir, 'child-range.txt')
    writeFileSync(p, numbered(60))
    const parent = makeContext()
    parent.readFileState.set(p, rangeEntry(p, 40, 6))

    const child = childContext(parent)
    const startedAt = Date.now()
    // Inside the slice the parent read: outside it the watcher says nothing anyway.
    childWrites(child, p, numbered(60, { 42: 'L42' }))
    await settleAsChild(child, startedAt)

    const attachments = await getChangedFileAttachments(parent)

    expect(typesOf(attachments)).not.toContain('edited_text_file')
    expect(childWrittenNames(attachments)).toEqual([[p]])
    expect(attachments).toHaveLength(1)
    expect(parent.readFileState.get(p)).toMatchObject({
      content: 'l40\nl41\nL42\nl43\nl44\nl45\n',
      timestamp: getFileModificationTime(p),
      offset: 40,
      limit: 6,
    })
  })

  test("an external edit after the child's write still yields a diff note", async () => {
    const p = join(dir, 'child-then-external.ts')
    writeFileSync(p, 'const a = 1\n')
    const parent = makeContext()
    parent.readFileState.set(
      p,
      postWriteEntry('const a = 1\n', getFileModificationTime(p)),
    )

    const child = childContext(parent)
    const startedAt = Date.now()
    childWrites(child, p, 'const a = 2\n')
    await settleAsChild(child, startedAt)
    // The user's editor, later: not the mtime the child left.
    writeAhead(p, 'const a = 3\n', 20)

    const attachments = await getChangedFileAttachments(parent)

    expect(typesOf(attachments)).toEqual(['edited_text_file'])
    expect((attachments[0] as { snippet: string }).snippet).toContain(
      'const a = 3',
    )
  })

  test("a sub-agent's own watcher still gets the diff", async () => {
    const p = join(dir, 'child-sibling.ts')
    writeFileSync(p, 'const a = 1\n')
    const parent = makeContext()
    parent.readFileState.set(
      p,
      postWriteEntry('const a = 1\n', getFileModificationTime(p)),
    )

    // Two sub-agents of one parent: the names are the session owner's, and a
    // sibling holding the old bytes still needs to see what changed.
    const sibling = childContext(parent)
    const child = childContext(parent)
    const startedAt = Date.now()
    childWrites(child, p, 'const a = 2\n')
    await settleAsChild(child, startedAt)

    const attachments = await getChangedFileAttachments(sibling)

    expect(typesOf(attachments)).toEqual(['edited_text_file'])
    expect((attachments[0] as { snippet: string }).snippet).toContain(
      'const a = 2',
    )
  })

  test("a write that was never settled as a child's is reported as today", async () => {
    const p = join(dir, 'child-unsettled.ts')
    writeFileSync(p, 'const a = 1\n')
    const parent = makeContext()
    parent.readFileState.set(
      p,
      postWriteEntry('const a = 1\n', getFileModificationTime(p)),
    )

    // The same write, with no settle to record it.
    childWrites(childContext(parent), p, 'const a = 2\n')

    const attachments = await getChangedFileAttachments(parent)

    expect(typesOf(attachments)).toEqual(['edited_text_file'])
    expect((attachments[0] as { snippet: string }).snippet).toContain(
      'const a = 2',
    )
  })
})
