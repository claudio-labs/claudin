// applySedEdit — the path a `sed -i` takes when the permission dialog showed
// the user a preview.
//
// It exists so that what was previewed is byte-for-byte what gets written:
// rather than re-running sed after approval (which could see a changed file, or
// a different sed), the already-computed new content is written directly. That
// makes three things load-bearing and none of them had a test before this file:
// the write itself, the readFileState refresh that keeps a later Edit from
// being refused as stale, and the sed-shaped error for a missing file.
//
// No mock.module anywhere here — the function takes its context as a narrow
// two-field object, so a real temp file and a real cache are enough.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { READ_FILE_STATE_CACHE_SIZE } from 'src/shared/fs/fileStateCache.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { applySedEdit } from 'src/tools/BashTool/applySedEdit.js'

type SedContext = Pick<ToolUseContext, 'readFileState' | 'updateFileHistoryState'>

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sed-edit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeContext(): SedContext & { historyCalls: number } {
  let historyCalls = 0
  const ctx = {
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    updateFileHistoryState: () => {
      historyCalls++
    },
    get historyCalls() {
      return historyCalls
    },
  }
  return ctx as unknown as SedContext & { historyCalls: number }
}

describe('applySedEdit', () => {
  test('writes the previewed content and reports sed-style success', async () => {
    const p = join(dir, 'file.txt')
    writeFileSync(p, 'before\n')
    const ctx = makeContext()

    const result = await applySedEdit({ filePath: p, newContent: 'after\n' }, ctx)

    expect(readFileSync(p, 'utf8')).toBe('after\n')
    // sed -i prints nothing on success, and the caller renders this verbatim.
    expect(result.data).toEqual({ stdout: '', stderr: '', interrupted: false })
  })

  test('refreshes readFileState so a following Edit is not refused as stale', async () => {
    const p = join(dir, 'tracked.txt')
    writeFileSync(p, 'old\n')
    const ctx = makeContext()
    // Seed the cache the way a prior Read would have.
    ctx.readFileState.set(p, {
      content: 'old\n',
      timestamp: 1,
      offset: 3,
      limit: 7,
    })

    await applySedEdit({ filePath: p, newContent: 'new\n' }, ctx)

    const entry = ctx.readFileState.get(p)
    expect(entry?.content).toBe('new\n')
    // The timestamp has to come from the file that was just written. Left at
    // the stale value, the next Edit reports the file as modified since read
    // and refuses — the exact failure this refresh exists to prevent.
    expect(entry?.timestamp).toBeGreaterThan(1)
    // A whole-file write invalidates any range the previous Read pinned.
    expect(entry?.offset).toBeUndefined()
    expect(entry?.limit).toBeUndefined()
  })

  test('a missing file answers like sed instead of throwing', async () => {
    const missing = join(dir, 'does-not-exist.txt')
    const ctx = makeContext()

    const result = await applySedEdit(
      { filePath: missing, newContent: 'ignored' },
      ctx,
    )

    // Shaped as sed's own stderr because it is rendered as command output; an
    // exception here would surface as a tool crash rather than a failed shell
    // command.
    expect(result.data.stderr).toBe(
      `sed: ${missing}: No such file or directory\nExit code 1`,
    )
    expect(result.data.stdout).toBe('')
    expect(result.data.interrupted).toBe(false)
  })

  test('a missing file leaves no cache entry behind', async () => {
    const missing = join(dir, 'absent.txt')
    const ctx = makeContext()

    await applySedEdit({ filePath: missing, newContent: 'ignored' }, ctx)

    expect(ctx.readFileState.get(missing)).toBeUndefined()
  })

  test('CRLF line endings survive the rewrite', async () => {
    const p = join(dir, 'crlf.txt')
    writeFileSync(p, 'one\r\ntwo\r\n')
    const ctx = makeContext()

    // The new content arrives with LF — the writer is what has to put the
    // file's own endings back, or a one-line sed turns the whole file into a
    // diff.
    await applySedEdit({ filePath: p, newContent: 'one\nthree\n' }, ctx)

    expect(readFileSync(p, 'utf8')).toBe('one\r\nthree\r\n')
  })

  // NOT covered here: the file-history branch. It is gated on
  // `fileHistoryEnabled() && parentMessage`, and fileHistoryEnabled() reads
  // config that is off under `bun test` — so the branch never runs either way
  // and an assertion on it passes with the gate deleted. A test was written
  // for it, the probe found it guarded nothing, and it was removed rather than
  // left standing as false coverage. Reaching it needs the config pinned in
  // beforeAll and restored in afterAll, which is process-global state this
  // file otherwise does not touch.
})
