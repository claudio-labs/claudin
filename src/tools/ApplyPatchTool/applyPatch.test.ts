import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from 'src/shared/fs/fsOperations.js'
import {
  applyPatchCacheInvalidationPaths,
  runApplyPatch,
  summarizeApplyPatch,
  thenSkippedFor,
  validateApplyPatchInput,
  resolveApplyPatchPaths,
} from 'src/tools/ApplyPatchTool/applyPatch.js'
import { RESUBMIT_SENTINEL } from 'src/tools/ApplyPatchTool/patchFormat.js'

beforeAll(() => {
  // Defend against an fs mock leaked from another test file in the shard.
  setOriginalFsImplementation()
})

let dir: string
let ctx: ToolUseContext

function makeContext(): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    readFileState: new FileStateCache(100, 10_000_000),
    updateFileHistoryState: () => {},
    agentId: undefined,
    getAppState: () => ({ toolPermissionContext }),
  } as unknown as ToolUseContext
}

function markRead(absPath: string): void {
  ctx.readFileState.set(absPath, {
    content: readFileSync(absPath, 'utf8'),
    timestamp: getFileModificationTime(absPath),
    offset: undefined,
    limit: undefined,
  })
}

/** A read the model only saw as an outline/symbol/range. */
function markPartial(absPath: string): void {
  ctx.readFileState.set(absPath, {
    content: readFileSync(absPath, 'utf8'),
    timestamp: getFileModificationTime(absPath),
    offset: undefined,
    limit: undefined,
    isPartialView: true,
  })
}

/** The clip-pin's sticky marker: the body was clipped out of the transcript. */
function markClipped(absPath: string): void {
  ctx.readFileState.set(absPath, {
    content: readFileSync(absPath, 'utf8'),
    timestamp: getFileModificationTime(absPath),
    offset: undefined,
    limit: undefined,
    isPartialView: true,
    standDownOutline: {
      message: '<outline>',
      servedOutline: true,
      epoch: 0,
      replays: 0,
    },
  })
}

function envelope(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`
}

/** A range Read: the model only saw lines [offset, offset + limit - 1]. */
function markRange(absPath: string, offset: number, limit: number): void {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  ctx.readFileState.set(absPath, {
    content: lines.slice(offset - 1, offset - 1 + limit).join('\n'),
    timestamp: getFileModificationTime(absPath),
    offset,
    limit,
  })
}

/** Ten numbered lines, so a range read can miss the patched one. */
function writeNumbered(absPath: string): void {
  writeFileSync(
    absPath,
    Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n',
  )
}

/**
 * A MEMORY.md the harness injected truncated to its first `seenLines` lines:
 * the entry carries the raw file, the model saw only the head.
 */
function markInjected(absPath: string, seenLines: number): void {
  const raw = readFileSync(absPath, 'utf8')
  ctx.readFileState.set(absPath, {
    content: raw,
    timestamp: getFileModificationTime(absPath),
    offset: undefined,
    limit: undefined,
    isPartialView: true,
    injectedView: raw.split('\n').slice(0, seenLines).join('\n'),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'applypatch-'))
  ctx = makeContext()
})

afterAll(() => {
  // best-effort cleanup of any leftover temp dirs is handled per-test below
})

function cleanup() {
  rmSync(dir, { recursive: true, force: true })
}

describe('runApplyPatch', () => {
  test('creates a file with Add File', async () => {
    const p = join(dir, 'new.ts')
    const { output } = await runApplyPatch(
      { patchText: envelope(`*** Add File: ${p}\n+export const x = 1`) },
      ctx,
      randomUUID(),
    )
    expect(readFileSync(p, 'utf8')).toBe('export const x = 1\n')
    expect(output.files).toHaveLength(1)
    expect(output.files[0]).toMatchObject({ type: 'add', additions: 1 })
    cleanup()
  })

  test('updates an existing file', async () => {
    const p = join(dir, 'a.txt')
    writeFileSync(p, 'line1\nline2\n')
    await runApplyPatch(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-line2\n+LINE2`) },
      ctx,
      randomUUID(),
    )
    expect(readFileSync(p, 'utf8')).toBe('line1\nLINE2\n')
    cleanup()
  })

  test('deletes a file', async () => {
    const p = join(dir, 'gone.txt')
    writeFileSync(p, 'bye\n')
    // The read gate lives in runApplyPatch since 2026-09-29, and a Delete of a
    // file never read is not applied.
    markRead(p)
    await runApplyPatch(
      { patchText: envelope(`*** Delete File: ${p}`) },
      ctx,
      randomUUID(),
    )
    expect(existsSync(p)).toBe(false)
    cleanup()
  })

  test('renames a file via Move to while editing', async () => {
    const src = join(dir, 'app.txt')
    const dest = join(dir, 'main.txt')
    writeFileSync(src, 'line1\nline2\n')
    const { output } = await runApplyPatch(
      {
        patchText: envelope(
          `*** Update File: ${src}\n*** Move to: ${dest}\n@@\n-line2\n+LINE2`,
        ),
      },
      ctx,
      randomUUID(),
    )
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(dest, 'utf8')).toBe('line1\nLINE2\n')
    expect(output.files[0]).toMatchObject({ type: 'move' })
    cleanup()
  })

  test('applies multiple files in one call', async () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'old.ts')
    writeFileSync(b, 'remove me\n')
    markRead(b)
    await runApplyPatch(
      {
        patchText: envelope(
          `*** Add File: ${a}\n+added\n*** Delete File: ${b}`,
        ),
      },
      ctx,
      randomUUID(),
    )
    expect(readFileSync(a, 'utf8')).toBe('added\n')
    expect(existsSync(b)).toBe(false)
    cleanup()
  })

  test('a hunk that fails leaves the rest of the patch applied, and says so', async () => {
    // Until 2026-09-29 this wrote nothing: the patch was all or nothing
    // (CLAUDIN_PATCH_ALL_OR_NOTHING=1 keeps that, pinned further down).
    const p = join(dir, 'a.txt')
    const q = join(dir, 'created.txt')
    writeFileSync(p, 'hello\n')
    markRead(p)
    const { output } = await runApplyPatch(
      {
        patchText: envelope(
          `*** Add File: ${q}\n+x\n*** Update File: ${p}\n@@\n-nonexistent\n+y`,
        ),
      },
      ctx,
      randomUUID(),
    )
    expect(readFileSync(q, 'utf8')).toBe('x\n')
    expect(readFileSync(p, 'utf8')).toBe('hello\n')
    expect(output.notApplied).toEqual([expect.stringContaining('Failed to find expected lines')])
    cleanup()
  })

  test('reports every unmatched section at once and writes nothing', async () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, 'hello\n')
    writeFileSync(b, 'world\n')
    let err: Error | undefined
    try {
      await runApplyPatch(
        {
          patchText: envelope(
            `*** Update File: ${a}\n@@\n-nope-a\n+x\n` +
              `*** Update File: ${b}\n@@\n-nope-b\n+y`,
          ),
        },
        ctx,
        randomUUID(),
      )
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain('2 of 2 changes')
    expect(err?.message).toContain(a)
    expect(err?.message).toContain(b)
    // Atomic: neither file changed.
    expect(readFileSync(a, 'utf8')).toBe('hello\n')
    expect(readFileSync(b, 'utf8')).toBe('world\n')
    cleanup()
  })

  test('refuses to overwrite an existing Move destination', async () => {
    const src = join(dir, 'src.txt')
    const dest = join(dir, 'dest.txt')
    writeFileSync(src, 'one\ntwo\n')
    writeFileSync(dest, 'PRECIOUS\n')
    await expect(
      runApplyPatch(
        {
          patchText: envelope(
            `*** Update File: ${src}\n*** Move to: ${dest}\n@@\n-two\n+TWO`,
          ),
        },
        ctx,
        randomUUID(),
      ),
    ).rejects.toThrow()
    // Destination untouched, source still present — no data lost.
    expect(readFileSync(dest, 'utf8')).toBe('PRECIOUS\n')
    expect(existsSync(src)).toBe(true)
    cleanup()
  })

  test('restores original content when an Update is rolled back', async () => {
    const a = join(dir, 'a.txt')
    const blocker = join(dir, 'blk')
    writeFileSync(a, 'ORIGINAL\n')
    writeFileSync(blocker, 'i am a file, not a dir\n')
    // Update a.txt succeeds, then the Add under a regular file fails mkdir.
    await expect(
      runApplyPatch(
        {
          patchText: envelope(
            `*** Update File: ${a}\n@@\n-ORIGINAL\n+CHANGED\n*** Add File: ${join(blocker, 'child.txt')}\n+x`,
          ),
        },
        ctx,
        randomUUID(),
      ),
    ).rejects.toThrow()
    // The committed Update must be reverted to its original content.
    expect(readFileSync(a, 'utf8')).toBe('ORIGINAL\n')
    cleanup()
  })

  test('rolls back a committed change when a later write fails', async () => {
    const first = join(dir, 'first.txt')
    // Second add targets a path *under* the first file, so mkdir fails mid-commit.
    const second = join(first, 'nested.txt')
    await expect(
      runApplyPatch(
        {
          patchText: envelope(
            `*** Add File: ${first}\n+one\n*** Add File: ${second}\n+two`,
          ),
        },
        ctx,
        randomUUID(),
      ),
    ).rejects.toThrow()
    // The first add was rolled back.
    expect(existsSync(first)).toBe(false)
    cleanup()
  })

  test('rolls back a move when unlinking the source fails (no orphaned destination)', async () => {
    const src = join(dir, 'src.txt')
    const dest = join(dir, 'dest.txt')
    writeFileSync(src, 'one\ntwo\n')

    // A move writes the destination, then unlinks the source. Simulate a
    // read-only source directory so that unlink throws *after* the destination
    // is on disk. The change must be tracked for rollback before the write, so
    // the orphaned destination gets removed and the source is left intact —
    // previously the post-write push skipped rollback and left a half-applied,
    // duplicated file behind while still propagating the error.
    const realFs = getFsImplementation()
    setFsImplementation({
      ...realFs,
      unlinkSync: (p: string) => {
        if (p === src) throw new Error('EACCES: simulated read-only source dir')
        return realFs.unlinkSync(p)
      },
    })
    try {
      await expect(
        runApplyPatch(
          {
            patchText: envelope(
              `*** Update File: ${src}\n*** Move to: ${dest}\n@@\n-two\n+TWO`,
            ),
          },
          ctx,
          randomUUID(),
        ),
      ).rejects.toThrow()
    } finally {
      setFsImplementation(realFs)
    }

    // Destination rolled back (not orphaned); source untouched — no half-apply.
    expect(existsSync(dest)).toBe(false)
    expect(readFileSync(src, 'utf8')).toBe('one\ntwo\n')
    cleanup()
  })
})

describe('validateApplyPatchInput', () => {
  test('a never-read file is reported as never read', () => {
    // Its hunk does not match it: an unread file whose hunks all match
    // exactly is patched (2026-09-29).
    const p = join(dir, 'unread.txt')
    writeFileSync(p, 'a\n')
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-zz\n+b`) },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) {
      expect(r.message).toContain('has not been read yet')
      expect(r.message).not.toContain("view='full'")
    }
    cleanup()
  })

  test('an outline-only read authorizes the patch', () => {
    const p = join(dir, 'partial.txt')
    writeFileSync(p, 'a\n')
    markPartial(p)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-a\n+b`) },
      ctx,
    )
    // Any read counts; whether the hunk applies is decided at apply time.
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('a Read since clipped out of the transcript authorizes the patch', () => {
    const p = join(dir, 'clipped.txt')
    writeFileSync(p, 'a\n')
    markClipped(p)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-a\n+b`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('two files needing a read get the batched-read instruction', () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, 'a\n')
    writeFileSync(b, 'a\n')
    // Neither was read, and the old sides are NOT in either file: nothing can
    // be served, so both refusals still need a Read (the served case has its
    // own suite below).
    const r = validateApplyPatchInput(
      {
        patchText: envelope(
          `*** Update File: ${a}\n@@\n-zz\n+b\n*** Update File: ${b}\n@@\n-zz\n+b`,
        ),
      },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) {
      expect(r.message).toContain('do them all in ONE message')
    }
    cleanup()
  })

  test('two problems but only ONE needing a read: no batched-read instruction', () => {
    // Pins the `readRemedyFailures >= 2` boundary. An earlier version of this
    // test used a single failing file, which the `failures.length === 1` early
    // return absorbs before the aggregate tail is ever built — so the negative
    // assertion could not fail and guarded nothing. Here there ARE two
    // problems (so the aggregate path runs) but only one is fixed by reading:
    // the other is a duplicate section.
    const a = join(dir, 'solo.txt')
    const b = join(dir, 'ok.txt')
    writeFileSync(a, 'a\n')
    writeFileSync(b, 'a\n')
    markRead(b)
    const r = validateApplyPatchInput(
      {
        patchText: envelope(
          `*** Update File: ${a}\n@@\n-zz\n+b` +
            `\n*** Update File: ${b}\n@@\n-a\n+b` +
            `\n*** Delete File: ${b}`,
        ),
      },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) {
      expect(r.message).toContain('2 problems')
      expect(r.message).toContain('appears in more than one section')
      expect(r.message).not.toContain('ONE message')
      // The header names the tool once; each bullet drops the prefix its
      // single-problem message carries.
      expect(r.message).not.toContain('• Patch:')
    }
    cleanup()
  })

  test('rejects a notebook target', () => {
    const p = join(dir, 'nb.ipynb')
    writeFileSync(p, '{}')
    markRead(p)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-{}\n+{ }`) },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) expect(r.message).toContain('NotebookEdit')
    cleanup()
  })

  test('rejects a duplicate path', () => {
    const p = join(dir, 'dup.txt')
    writeFileSync(p, 'a\n')
    markRead(p)
    const r = validateApplyPatchInput(
      {
        patchText: envelope(
          `*** Update File: ${p}\n@@\n-a\n+b\n*** Delete File: ${p}`,
        ),
      },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) expect(r.message).toContain('more than one section')
    cleanup()
  })

  test('rejects Update of an unread file its hunk does not match (read-before-edit)', () => {
    const p = join(dir, 'unread.txt')
    writeFileSync(p, 'a\n')
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-zz\n+b`) },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) expect(r.message).toContain('has not been read')
    cleanup()
  })

  test('accepts Update of an unread file every hunk of which matches exactly', () => {
    const p = join(dir, 'unread-exact.txt')
    writeFileSync(p, 'alpha\n')
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-alpha\n+beta`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('rejects Add of an existing file', () => {
    const p = join(dir, 'exists.txt')
    writeFileSync(p, 'a\n')
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Add File: ${p}\n+x`) },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) expect(r.message).toContain('already exists')
    cleanup()
  })

  test('reports every problem at once across sections', () => {
    // One unread file + one duplicate section: both must surface in a single
    // failure so the model fixes them together, not one resubmit at a time.
    const unread = join(dir, 'unread.txt')
    const dup = join(dir, 'dup.txt')
    writeFileSync(unread, 'a\n')
    writeFileSync(dup, 'a\n')
    markRead(dup)
    const r = validateApplyPatchInput(
      {
        patchText: envelope(
          `*** Update File: ${unread}\n@@\n-zz\n+b\n` +
            `*** Update File: ${dup}\n@@\n-a\n+b\n` +
            `*** Delete File: ${dup}`,
        ),
      },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) {
      expect(r.message).toContain('2 problems')
      expect(r.message).toContain('has not been read')
      expect(r.message).toContain('more than one section')
    }
    cleanup()
  })

  test('accepts a read, well-formed update', () => {
    const p = join(dir, 'ok.txt')
    writeFileSync(p, 'a\n')
    markRead(p)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-a\n+b`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('returns a clean failure (not a throw) for a null-byte path', () => {
    // A NUL in a path makes path.resolve throw; validate must surface it as a
    // structured failure rather than letting it escape as an uncaught error.
    const r = validateApplyPatchInput(
      { patchText: envelope('*** Add File: foo\0bar.txt\n+x') },
      ctx,
    )
    expect(r.result).toBe(false)
    if (!r.result) expect(r.message).toContain('invalid path')
    cleanup()
  })
})

// Any read counts ("Read gate" in applyPatch.ts). Until 2026-09-24 a range read
// only authorized hunks inside it, a Delete needed the whole file, and a file
// changed on disk since the read was refused — each answered, half the time,
// with a Read and the identical patch. What stops a wrong hunk now is the
// patch itself, matched against the file when it is applied.
describe('validateApplyPatchInput — any read counts', () => {
  test('a range read authorizes a patch INSIDE the range', () => {
    const p = join(dir, 'inside.txt')
    writeNumbered(p)
    markRange(p, 1, 3)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-line2\n+LINE2`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('a range read authorizes a patch outside it too', async () => {
    const p = join(dir, 'outside.txt')
    writeNumbered(p)
    markRange(p, 1, 3)
    const input = {
      patchText: envelope(`*** Update File: ${p}\n@@\n line7\n-line8\n+LINE8`),
    }
    expect(validateApplyPatchInput(input, ctx)).toEqual({ result: true })
    await runApplyPatch(input, ctx, randomUUID())
    expect(readFileSync(p, 'utf8')).toContain('line7\nLINE8\nline9')
    cleanup()
  })

  test('a full read still authorizes a patch anywhere in the file', () => {
    const p = join(dir, 'full.txt')
    writeNumbered(p)
    markRead(p)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-line8\n+LINE8`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('a range read authorizes a Delete File', () => {
    const p = join(dir, 'del.txt')
    writeNumbered(p)
    markRange(p, 1, 3)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Delete File: ${p}`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('Delete File after a full read is allowed', () => {
    const p = join(dir, 'del-ok.txt')
    writeNumbered(p)
    markRead(p)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Delete File: ${p}`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('an injected file authorizes an Update inside what the model saw', () => {
    const p = join(dir, 'injected-in.md')
    writeNumbered(p)
    markInjected(p, 3)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-line2\n+LINE2`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('an injected file authorizes an Update past the truncation too', () => {
    const p = join(dir, 'injected-out.md')
    writeNumbered(p)
    markInjected(p, 3)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-line8\n+LINE8`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('an injected file authorizes a Delete', () => {
    const p = join(dir, 'injected-del.md')
    writeNumbered(p)
    markInjected(p, 3)
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Delete File: ${p}`) },
      ctx,
    )
    expect(r).toEqual({ result: true })
    cleanup()
  })

  test('a file changed on disk since the read is patched as it is now', async () => {
    const p = join(dir, 'changed.txt')
    writeNumbered(p)
    markRead(p)
    writeFileSync(p, readFileSync(p, 'utf8').replace('line8', 'LINE8'))
    const when = new Date(Date.now() + 10_000)
    utimesSync(p, when, when)

    const input = { patchText: envelope(`*** Update File: ${p}\n@@\n-line2\n+LINE2`) }
    expect(validateApplyPatchInput(input, ctx)).toEqual({ result: true })
    await runApplyPatch(input, ctx, randomUUID())
    // The change made after the read survives: the hunk named line2 only.
    const after = readFileSync(p, 'utf8')
    expect(after).toContain('LINE2')
    expect(after).toContain('LINE8')
    cleanup()
  })

  // Since 2026-09-29 a file never read is patched when every hunk matches it
  // exactly, so what a read still buys is a hunk that does NOT match exactly:
  // after any read it goes on to the call (and its reason), never read it is
  // refused up front. That is where each kind of read has to count.
  test.each([
    ['a partial view', (p: string) => markPartial(p)],
    ['a range read that does not cover the hunk', (p: string) => markRange(p, 1, 2)],
    [
      'a read of an older version of the file',
      (p: string) => {
        markRead(p)
        const later = new Date(Date.now() + 60_000)
        utimesSync(p, later, later)
      },
    ],
  ])('%s is a read: a hunk that matches nowhere still passes validation', (_kind, mark) => {
    const p = join(dir, 'kinds.txt')
    writeNumbered(p)
    mark(p)
    expect(validateApplyPatchInput({ patchText: envelope(`*** Update File: ${p}\n@@\n-nowhere\n+x`) }, ctx)).toEqual({
      result: true,
    })
    cleanup()
  })

  test('a hunk that does not match the file passes validation and is refused when applied', async () => {
    const p = join(dir, 'mismatch.txt')
    writeNumbered(p)
    markPartial(p)
    const before = readFileSync(p, 'utf8')
    const input = { patchText: envelope(`*** Update File: ${p}\n@@\n-nowhere\n+x`) }
    expect(validateApplyPatchInput(input, ctx)).toEqual({ result: true })
    await expect(runApplyPatch(input, ctx, randomUUID())).rejects.toThrow(
      'Failed to find expected lines',
    )
    expect(readFileSync(p, 'utf8')).toBe(before)
    cleanup()
  })

  describe('CLAUDIN_PATCH_ALL_OR_NOTHING=1: the refusal serves the region when the old side matches exactly', () => {
    // Under the killswitch a file never read is still refused
    // (tool-error-census-2026-09-20.md: half the resubmits after a forced Read
    // were byte-identical). When the hunk's old side is in the file exactly
    // once, the refusal carries it and registers it, so the identical resend
    // passes. By default such a file is patched outright (2026-09-29).
    beforeEach(() => {
      process.env.CLAUDIN_PATCH_ALL_OR_NOTHING = '1'
    })
    afterEach(() => {
      delete process.env.CLAUDIN_PATCH_ALL_OR_NOTHING
    })

    test('a never-read refusal carries the lines and the same patch then applies', () => {
      const p = join(dir, 'serve-never.txt')
      writeNumbered(p)
      const body = `*** Update File: ${p}\n@@\n line7\n-line8\n+LINE8\n line9`
      const first = validateApplyPatchInput({ patchText: envelope(body) }, ctx)
      expect(first).toMatchObject({ result: false })
      if (!first.result) {
        expect(first.message).toContain('has not been read yet')
        expect(first.message).toContain('now count as read')
        // Two lines of context on each side of the matched block.
        expect(first.message).toContain('5→line5')
        expect(first.message).toContain('8→line8')
        expect(first.message).toContain('10→line10')
        expect(first.message).not.toContain('4→line4')
        expect(first.message).not.toContain('do them all in ONE message')
      }
      expect(validateApplyPatchInput({ patchText: envelope(body) }, ctx)).toEqual(
        { result: true },
      )
      cleanup()
    })

    test('an ambiguous old side is not served', () => {
      const p = join(dir, 'serve-ambiguous.txt')
      writeFileSync(p, 'same\nother\nsame\nend\n')
      const r = validateApplyPatchInput(
        { patchText: envelope(`*** Update File: ${p}\n@@\n-same\n+SAME`) },
        ctx,
      )
      expect(r).toMatchObject({ result: false })
      if (!r.result) expect(r.message).not.toContain('→')
      cleanup()
    })

    test('an old side that is not in the file is not served', () => {
      const p = join(dir, 'serve-miss.txt')
      writeNumbered(p)
      const r = validateApplyPatchInput(
        { patchText: envelope(`*** Update File: ${p}\n@@\n-nowhere\n+x`) },
        ctx,
      )
      expect(r).toMatchObject({ result: false })
      if (!r.result) expect(r.message).not.toContain('→')
      cleanup()
    })

    test('a Delete File is never served — it has no old side', () => {
      const p = join(dir, 'serve-delete.txt')
      writeNumbered(p)
      const r = validateApplyPatchInput(
        { patchText: envelope(`*** Delete File: ${p}`) },
        ctx,
      )
      expect(r).toMatchObject({ result: false })
      if (!r.result) expect(r.message).not.toContain('→')
      cleanup()
    })

    test('in a multi-file patch, served and unserved sections are told apart', () => {
      const a = join(dir, 'serve-multi-a.txt')
      const b = join(dir, 'serve-multi-b.txt')
      writeNumbered(a)
      writeNumbered(b)
      const r = validateApplyPatchInput(
        {
          patchText: envelope(
            `*** Update File: ${a}\n@@\n-line5\n+LINE5\n` +
              `*** Update File: ${b}\n@@\n-nowhere\n+x`,
          ),
        },
        ctx,
      )
      expect(r).toMatchObject({ result: false })
      if (!r.result) {
        expect(r.message).toContain('found 2 problems')
        expect(r.message).toContain('5→line5')
        // Only ONE section still needs a Read, so no batched-read instruction.
        expect(r.message).not.toContain('do them all in ONE message')
      }
      cleanup()
    })

    test('served sections do not count toward the batched-read hint', () => {
      // Neither file was read and both hunks match exactly: two refusals, both
      // served, and no Read is owed for either — so the "do them all in ONE
      // message" hint, which is advice to batch Reads, must stay out of it.
      const a = join(dir, 'serve-two-a.txt')
      const b = join(dir, 'serve-two-b.txt')
      writeNumbered(a)
      writeNumbered(b)
      const body =
        `*** Update File: ${a}\n@@\n-line8\n+LINE8\n` +
        `*** Update File: ${b}\n@@\n-line9\n+LINE9`
      const r = validateApplyPatchInput({ patchText: envelope(body) }, ctx)
      expect(r).toMatchObject({ result: false })
      if (!r.result) {
        expect(r.message).toContain('found 2 problems')
        expect(r.message).toContain('8→line8')
        expect(r.message).toContain('9→line9')
        expect(r.message).not.toContain('do them all in ONE message')
      }
      expect(validateApplyPatchInput({ patchText: envelope(body) }, ctx)).toEqual({
        result: true,
      })
      cleanup()
    })
  })
})

// `*** Resubmit` (2026-09-23 → 09-29) applied the patch a served read-gate
// refusal had kept. A never-read file whose hunks match exactly is now applied
// outright, so nothing is kept and the sentinel is just text again.
describe('the retired resubmit sentinel', () => {
  test('is an unparseable patch, not a reference to a kept one', () => {
    const r = validateApplyPatchInput({ patchText: RESUBMIT_SENTINEL }, ctx)
    expect(r).toMatchObject({ result: false })
    if (!r.result) expect(r.message).toContain('failed to parse the patch')
  })
})

describe('helpers', () => {
  test('resolveApplyPatchPaths lists every touched path including move dest', () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    const paths = resolveApplyPatchPaths({
      patchText: envelope(
        `*** Update File: ${a}\n*** Move to: ${b}\n@@\n-x\n+y`,
      ),
    })
    expect(paths).toEqual([a, b])
    cleanup()
  })

  test('applyPatchCacheInvalidationPaths emits raw + resolved forms', () => {
    // A relative envelope path: the raw string AND the cwd-resolved absolute
    // form must both be returned so the read-only cache invalidates whether a
    // prior Read/Grep keyed on the relative or the absolute path.
    const raw = resolveApplyPatchPaths({
      patchText: envelope('*** Add File: rel/new.ts\n+x'),
    })[0]
    const out = applyPatchCacheInvalidationPaths({
      patchText: envelope('*** Add File: rel/new.ts\n+x'),
    })
    expect(out).toContain('rel/new.ts') // raw, as the model wrote it
    expect(out).toContain(raw) // resolved absolute
  })

  test('applyPatchCacheInvalidationPaths returns [] for an unparseable patch', () => {
    expect(applyPatchCacheInvalidationPaths({ patchText: 'not a patch' })).toEqual([])
  })

  test('summarizeApplyPatch lists A/M/D per file', () => {
    const summary = summarizeApplyPatch({
      files: [
        {
          absPath: '/tmp/x/new.ts',
          type: 'add',
          additions: 1,
          deletions: 0,
          structuredPatch: [],
        },
        {
          absPath: '/tmp/x/old.ts',
          type: 'delete',
          additions: 0,
          deletions: 2,
          structuredPatch: [],
        },
      ],
    })
    expect(summary).toContain('A ')
    expect(summary).toContain('D ')
    cleanup()
  })
})

// Until 2026-09-29 one hunk that did not match, one unread file or one
// duplicate section refused the whole patch, and the model re-sent all of it
// (603k chars over 115 real retries, ~62% of them hunks that would have
// applied). Now every change that matches is written, and the result lists
// the rest; applying the same change twice changes nothing.
describe('applies what matches, reports the rest', () => {
  const run = (body: string) => runApplyPatch({ patchText: envelope(body) }, ctx, randomUUID())

  test('a hunk that fails in one file leaves the other files applied', async () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, 'one\ntwo\n')
    writeFileSync(b, 'uno\ndos\n')
    markRead(a)
    markRead(b)
    const { output } = await run(`*** Update File: ${a}\n@@\n-two\n+TWO\n*** Update File: ${b}\n@@\n-nowhere\n+x`)
    expect(readFileSync(a, 'utf8')).toBe('one\nTWO\n')
    expect(readFileSync(b, 'utf8')).toBe('uno\ndos\n')
    expect(output.files.map(f => f.absPath)).toEqual([a])
    expect(output.notApplied).toEqual([expect.stringContaining('Failed to find expected lines')])
    const summary = summarizeApplyPatch(output)
    expect(summary).toContain('M ')
    expect(summary).toContain('NOT applied')
    cleanup()
  })

  test('the other hunks of the same file still apply, and every failure is listed', async () => {
    const p = join(dir, 'p.txt')
    writeFileSync(p, 'a\nb\nc\nd\n')
    markRead(p)
    const { output } = await run(`*** Update File: ${p}\n@@\n-a\n+A\n@@\n-nope1\n+x\n@@\n-c\n+C\n@@\n-nope2\n+y`)
    expect(readFileSync(p, 'utf8')).toBe('A\nb\nC\nd\n')
    expect(output.notApplied).toHaveLength(2)
    cleanup()
  })

  test('when nothing applies it is an error that lists every problem, and nothing is written', async () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, 'x\n')
    writeFileSync(b, 'y\n')
    markRead(a)
    markRead(b)
    let err: Error | undefined
    try {
      await run(`*** Update File: ${a}\n@@\n-nope-a\n+1\n*** Update File: ${b}\n@@\n-nope-b\n+2`)
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain('nope-a')
    expect(err?.message).toContain('nope-b')
    expect(readFileSync(a, 'utf8')).toBe('x\n')
    expect(readFileSync(b, 'utf8')).toBe('y\n')
    cleanup()
  })

  test('re-sending an applied patch changes nothing and says it is already applied', async () => {
    const p = join(dir, 'p.txt')
    writeFileSync(p, 'alpha\nbeta\n')
    markRead(p)
    const body = `*** Update File: ${p}\n@@\n-beta\n+BETA`
    await run(body)
    markRead(p)
    const { output } = await run(body)
    expect(readFileSync(p, 'utf8')).toBe('alpha\nBETA\n')
    expect(output.files).toEqual([])
    expect(output.alreadyApplied).toHaveLength(1)
    expect(summarizeApplyPatch(output)).toContain('already')
    cleanup()
  })

  test('Add of a file that already has that content is already applied', async () => {
    const p = join(dir, 'same.txt')
    writeFileSync(p, 'hello\n')
    const { output } = await run(`*** Add File: ${p}\n+hello`)
    expect(output.alreadyApplied).toHaveLength(1)
    expect(output.notApplied ?? []).toEqual([])
    cleanup()
  })

  test('Add of a file that exists with other content is not applied, the rest is', async () => {
    const taken = join(dir, 'taken.txt')
    const fresh = join(dir, 'fresh.txt')
    writeFileSync(taken, 'PRECIOUS\n')
    const { output } = await run(`*** Add File: ${taken}\n+other\n*** Add File: ${fresh}\n+new`)
    expect(readFileSync(taken, 'utf8')).toBe('PRECIOUS\n')
    expect(readFileSync(fresh, 'utf8')).toBe('new\n')
    expect(output.notApplied).toEqual([expect.stringContaining('already exists')])
    cleanup()
  })

  test('Delete of a file that is already gone is already applied', async () => {
    const gone = join(dir, 'gone.txt')
    const { output } = await run(`*** Delete File: ${gone}`)
    expect(output.alreadyApplied).toHaveLength(1)
    cleanup()
  })

  test('two Update sections for one file both apply', async () => {
    const p = join(dir, 'two.txt')
    writeFileSync(p, 'a\nb\nc\n')
    markRead(p)
    const { output } = await run(`*** Update File: ${p}\n@@\n-c\n+C\n*** Update File: ${p}\n@@\n-a\n+A`)
    expect(readFileSync(p, 'utf8')).toBe('A\nb\nC\n')
    expect(output.files).toHaveLength(1)
    cleanup()
  })

  test('an Add and an Update of one path are not applied, the rest is', async () => {
    const p = join(dir, 'clash.txt')
    const q = join(dir, 'fine.txt')
    writeFileSync(p, 'a\n')
    writeFileSync(q, 'q\n')
    markRead(p)
    markRead(q)
    const { output } = await run(`*** Add File: ${p}\n+x\n*** Update File: ${p}\n@@\n-a\n+A\n*** Update File: ${q}\n@@\n-q\n+Q`)
    expect(readFileSync(p, 'utf8')).toBe('a\n')
    expect(readFileSync(q, 'utf8')).toBe('Q\n')
    expect(output.notApplied?.join('\n')).toContain('more than one section')
    cleanup()
  })

  test('a file never read applies when every hunk matches it exactly', async () => {
    const p = join(dir, 'unread.txt')
    writeNumbered(p)
    const { output } = await run(`*** Update File: ${p}\n@@\n-line5\n+LINE5`)
    expect(readFileSync(p, 'utf8')).toContain('LINE5')
    expect(ctx.readFileState.get(p)).toBeDefined()
    expect(summarizeApplyPatch(output)).toContain('had not been read')
    cleanup()
  })

  test('a file never read whose hunk does not match exactly is not applied, the rest is', async () => {
    const unread = join(dir, 'unread.txt')
    const read = join(dir, 'read.txt')
    writeNumbered(unread)
    writeFileSync(read, 'r\n')
    markRead(read)
    const { output } = await run(`*** Update File: ${unread}\n@@\n-line55\n+X\n*** Update File: ${read}\n@@\n-r\n+R`)
    expect(readFileSync(unread, 'utf8')).not.toContain('X')
    expect(readFileSync(read, 'utf8')).toBe('R\n')
    expect(output.notApplied).toEqual([expect.stringContaining('has not been read')])
    cleanup()
  })

  test('Delete of a file never read is not applied', async () => {
    const p = join(dir, 'keep.txt')
    const q = join(dir, 'q.txt')
    writeFileSync(p, 'keep\n')
    writeFileSync(q, 'q\n')
    markRead(q)
    const { output } = await run(`*** Delete File: ${p}\n*** Update File: ${q}\n@@\n-q\n+Q`)
    expect(existsSync(p)).toBe(true)
    expect(output.notApplied).toEqual([expect.stringContaining('has not been read')])
    // A Delete has no hunks to match: it is refused for the read alone.
    expect(output.notApplied![0]).not.toContain('do not match')
    cleanup()
  })

  test('validation refuses only a patch in which nothing could apply', () => {
    const taken = join(dir, 'taken.txt')
    const p = join(dir, 'p.txt')
    writeFileSync(taken, 'PRECIOUS\n')
    writeFileSync(p, 'a\n')
    markRead(p)
    const mixed = validateApplyPatchInput(
      { patchText: envelope(`*** Add File: ${taken}\n+other\n*** Update File: ${p}\n@@\n-a\n+A`) },
      ctx,
    )
    expect(mixed).toEqual({ result: true })
    const hopeless = validateApplyPatchInput({ patchText: envelope(`*** Add File: ${taken}\n+other`) }, ctx)
    expect(hopeless).toMatchObject({ result: false })
    cleanup()
  })

  test('then is skipped when something did not apply, so it does not check half a patch', () => {
    expect(thenSkippedFor({ files: [] })).toBeUndefined()
    expect(thenSkippedFor({ files: [], alreadyApplied: ['x'] })).toBeUndefined()
    expect(thenSkippedFor({ files: [], notApplied: ['a', 'b'] })).toContain('2 changes did not apply')
  })

  describe('CLAUDIN_PATCH_ALL_OR_NOTHING=1 restores the atomic patch', () => {
    beforeEach(() => {
      process.env.CLAUDIN_PATCH_ALL_OR_NOTHING = '1'
    })
    afterEach(() => {
      delete process.env.CLAUDIN_PATCH_ALL_OR_NOTHING
    })

    test('one hunk that fails writes nothing', async () => {
      const a = join(dir, 'a.txt')
      const b = join(dir, 'b.txt')
      writeFileSync(a, 'one\n')
      writeFileSync(b, 'uno\n')
      markRead(a)
      markRead(b)
      await expect(run(`*** Update File: ${a}\n@@\n-one\n+ONE\n*** Update File: ${b}\n@@\n-nowhere\n+x`)).rejects.toThrow(
        'Failed to find expected lines',
      )
      expect(readFileSync(a, 'utf8')).toBe('one\n')
      cleanup()
    })

    test('a file never read is refused before anything runs', () => {
      const p = join(dir, 'unread.txt')
      writeNumbered(p)
      const r = validateApplyPatchInput({ patchText: envelope(`*** Update File: ${p}\n@@\n-line5\n+LINE5`) }, ctx)
      expect(r).toMatchObject({ result: false })
      cleanup()
    })
  })
})
