import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { getFileModificationTime } from '../../utils/file.js'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../utils/fsOperations.js'
import {
  applyPatchCacheInvalidationPaths,
  runApplyPatch,
  summarizeApplyPatch,
  validateApplyPatchInput,
  resolveApplyPatchPaths,
} from './applyPatch.js'

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

function envelope(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`
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

  test('applies multiple files atomically', async () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'old.ts')
    writeFileSync(b, 'remove me\n')
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

  test('writes nothing when a hunk fails to apply', async () => {
    const p = join(dir, 'a.txt')
    const q = join(dir, 'created.txt')
    writeFileSync(p, 'hello\n')
    await expect(
      runApplyPatch(
        {
          patchText: envelope(
            `*** Add File: ${q}\n+x\n*** Update File: ${p}\n@@\n-nonexistent\n+y`,
          ),
        },
        ctx,
        randomUUID(),
      ),
    ).rejects.toThrow('Failed to find expected lines')
    // Staging fails before any write — the Add must not have happened.
    expect(existsSync(q)).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe('hello\n')
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
    expect(err?.message).toContain('2 of 2 file sections')
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

  test('rejects Update of an unread file (read-before-edit)', () => {
    const p = join(dir, 'unread.txt')
    writeFileSync(p, 'a\n')
    const r = validateApplyPatchInput(
      { patchText: envelope(`*** Update File: ${p}\n@@\n-a\n+b`) },
      ctx,
    )
    expect(r).toMatchObject({ result: false })
    if (!r.result) expect(r.message).toContain('has not been read')
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
          `*** Update File: ${unread}\n@@\n-a\n+b\n` +
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
