import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID, type UUID } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  getIsInteractive,
  getOriginalCwd,
  getSessionId,
  setIsInteractive,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import {
  checkOriginFileChanged,
  fileHistoryCanRestore,
  fileHistoryGetDiffStats,
  fileHistoryHasAnyChanges,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from 'src/shared/fs/fileHistory.js'

/**
 * Characterization of the checkpoint store behind rewind: what a tracked edit
 * backs up, what a snapshot keeps, and what a rewind does to the disk. Written
 * before post-write fingerprints and rewind-conflict detection land in
 * fileHistory.ts, so every assertion here is the behavior as it stood.
 *
 * Driven the way the REPL drives it (FileEditTool → trackEdit, handlePromptSubmit
 * → makeSnapshot): an updater callback over a plain in-memory state, real files
 * in a temp project, backups under a temp CLAUDIN_CONFIG_DIR. No module mocks.
 *
 * The session is non-interactive under bun test, so the gate that matters is
 * CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING (fileHistory.ts:72).
 *
 * This file pins the read and restore side (rewind, canRestore, diff stats,
 * hasAnyChanges, checkOriginFileChanged). The write side is
 * fileHistory.test.ts and the resume half fileHistory.resume.test.ts; each
 * repeats this setup so its hooks register in its own scope.
 */

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDIN_DISABLE_FILE_CHECKPOINTING',
] as const
const savedEnv: Record<string, string | undefined> = {}
let savedCwd = ''
let savedInteractive = false
let root = ''
let configDir = ''
let project = ''

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  savedCwd = getOriginalCwd()
  savedInteractive = getIsInteractive()
  root = mkdtempSync(join(tmpdir(), 'fileHistoryRewind-'))
  configDir = join(root, 'config')
  setOriginalFsImplementation()
})

beforeEach(() => {
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING = '1'
  delete process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING
  setIsInteractive(false)
  project = mkdtempSync(join(root, 'project-'))
  setOriginalCwd(project)
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setOriginalCwd(savedCwd)
  setIsInteractive(savedInteractive)
  rmSync(root, { recursive: true, force: true })
})

type Updater = (prev: FileHistoryState) => FileHistoryState

function emptyState(): FileHistoryState {
  return { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
}

/** The AppState slice the REPL keeps, minus React. */
function holder(initial: FileHistoryState = emptyState()) {
  let state = initial
  let calls = 0
  return {
    update: (updater: Updater) => {
      calls++
      state = updater(state)
    },
    get state() {
      return state
    },
    get calls() {
      return calls
    },
  }
}

const msg = (): UUID => randomUUID()

function backupName(absPath: string, version: number): string {
  const hash = createHash('sha256').update(absPath).digest('hex').slice(0, 16)
  return `${hash}@v${version}`
}

function backupPath(name: string): string {
  return join(configDir, 'file-history', getSessionId(), name)
}

function file(rel: string, content: string): string {
  const abs = join(project, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

const OLD = new Date('2000-01-01T00:00:00Z')

/** Submit m1, then the agent edits `abs` under m1 — the REPL's order. */
async function editedUnder(abs: string, content: string) {
  const h = holder()
  const m1 = msg()
  await fileHistoryMakeSnapshot(h.update, m1)
  await fileHistoryTrackEdit(h.update, abs, m1)
  writeFileSync(abs, content)
  return { h, m1 }
}

describe('fileHistoryRewind', () => {
  test('restores a file the agent changed to its bytes at the target message', async () => {
    const abs = file('a.txt', 'original\n')
    const { h, m1 } = await editedUnder(abs, 'agent wrote this\n')
    await fileHistoryMakeSnapshot(h.update, msg())
    await fileHistoryRewind(h.update, m1)
    expect(readFileSync(abs, 'utf-8')).toBe('original\n')
  })

  test('also restores the mode', async () => {
    const abs = file('run.sh', 'echo\n')
    chmodSync(abs, 0o700)
    const { h, m1 } = await editedUnder(abs, 'echo hi\n')
    chmodSync(abs, 0o644)
    await fileHistoryRewind(h.update, m1)
    expect(statSync(abs).mode & 0o777).toBe(0o700)
  })

  test('overwrites a manual edit to a tracked file made after the agent wrote it (current behavior)', async () => {
    const abs = file('a.txt', 'original\n')
    const { h, m1 } = await editedUnder(abs, 'agent\n')
    await fileHistoryMakeSnapshot(h.update, msg())
    writeFileSync(abs, 'my manual edit\n')
    await fileHistoryRewind(h.update, m1)
    expect(readFileSync(abs, 'utf-8')).toBe('original\n')
  })

  test('deletes a file that did not exist at the target', async () => {
    const abs = join(project, 'created.txt')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    writeFileSync(abs, 'new file')
    await fileHistoryRewind(h.update, m1)
    expect(existsSync(abs)).toBe(false)
  })

  test('a null-backup file that is already gone is left alone', async () => {
    const abs = join(project, 'never.txt')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    await fileHistoryRewind(h.update, m1)
    expect(existsSync(abs)).toBe(false)
  })

  test('leaves an unchanged file untouched (no rewrite, mtime kept)', async () => {
    const changed = file('changed.txt', 'c0')
    const same = file('same.txt', 'same')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, changed, m1)
    await fileHistoryTrackEdit(h.update, same, m1)
    writeFileSync(changed, 'c1')
    utimesSync(same, OLD, OLD)
    await fileHistoryRewind(h.update, m1)
    expect(readFileSync(changed, 'utf-8')).toBe('c0')
    expect(statSync(same).mtimeMs).toBe(OLD.getTime())
  })

  test('recreates a deleted file and its missing parent directory', async () => {
    const abs = file('deep/dir/a.txt', 'kept')
    const { h, m1 } = await editedUnder(abs, 'changed')
    rmSync(join(project, 'deep'), { recursive: true })
    await fileHistoryRewind(h.update, m1)
    expect(readFileSync(abs, 'utf-8')).toBe('kept')
  })

  test('a file first tracked after the target is restored to its v1 backup', async () => {
    const abs = file('a.txt', 'before m2\n')
    const h = holder()
    const m1 = msg()
    const m2 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryMakeSnapshot(h.update, m2)
    await fileHistoryTrackEdit(h.update, abs, m2)
    writeFileSync(abs, 'edited under m2\n')
    await fileHistoryRewind(h.update, m1)
    expect(readFileSync(abs, 'utf-8')).toBe('before m2\n')
  })

  test('a file first tracked after the target as new is deleted', async () => {
    const abs = join(project, 'later.txt')
    const h = holder()
    const m1 = msg()
    const m2 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryMakeSnapshot(h.update, m2)
    await fileHistoryTrackEdit(h.update, abs, m2)
    writeFileSync(abs, 'x')
    await fileHistoryRewind(h.update, m1)
    expect(existsSync(abs)).toBe(false)
  })

  test('a tracked file with no v1 anywhere is not touched', async () => {
    const abs = file('orphan.txt', 'current')
    const h = holder({
      snapshots: [{ messageId: msg(), trackedFileBackups: {}, timestamp: new Date() }],
      trackedFiles: new Set(['orphan.txt']),
      snapshotSequence: 1,
    })
    await fileHistoryRewind(h.update, h.state.snapshots[0]!.messageId)
    expect(readFileSync(abs, 'utf-8')).toBe('current')
  })

  test('a backup missing on disk leaves the file as it is', async () => {
    const abs = file('a.txt', 'orig')
    const { h, m1 } = await editedUnder(abs, 'edited')
    rmSync(backupPath(backupName(abs, 1)))
    await fileHistoryRewind(h.update, m1)
    expect(readFileSync(abs, 'utf-8')).toBe('edited')
  })

  test('targets the last snapshot with that message id', async () => {
    const abs = file('a.txt', 'one')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    writeFileSync(abs, 'two')
    await fileHistoryMakeSnapshot(h.update, m1) // same id again: backs up 'two'
    writeFileSync(abs, 'three')
    await fileHistoryRewind(h.update, m1)
    expect(readFileSync(abs, 'utf-8')).toBe('two')
  })

  test('returns nothing and leaves the state alone; the changed list is dropped (current behavior)', async () => {
    const abs = file('a.txt', 'a')
    const { h, m1 } = await editedUnder(abs, 'b')
    const before = h.state
    expect(await fileHistoryRewind(h.update, m1)).toBeUndefined()
    expect(h.state).toBe(before)
  })

  test('an unknown message id throws', async () => {
    const h = holder()
    await fileHistoryMakeSnapshot(h.update, msg())
    await expect(fileHistoryRewind(h.update, msg())).rejects.toThrow(
      'The selected snapshot was not found',
    )
  })
})

describe('fileHistoryCanRestore', () => {
  test('true only for a message that has a snapshot', async () => {
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    expect(fileHistoryCanRestore(h.state, m1)).toBe(true)
    expect(fileHistoryCanRestore(h.state, msg())).toBe(false)
  })
})

describe('fileHistoryGetDiffStats', () => {
  test('counts lines from the rewind side: insertions are what the rewind adds back', async () => {
    const abs = file('a.txt', 'a\nb\nc\n')
    const { h, m1 } = await editedUnder(abs, 'a\nB\nc\nd\n')
    expect(await fileHistoryGetDiffStats(h.state, m1)).toEqual({
      filesChanged: [abs],
      insertions: 1,
      deletions: 2,
    })
  })

  test('sums across files and skips unchanged ones', async () => {
    const one = file('one.txt', 'x\n')
    const two = file('two.txt', 'p\nq\n')
    const same = file('same.txt', 'same\n')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    for (const f of [one, two, same]) await fileHistoryTrackEdit(h.update, f, m1)
    writeFileSync(one, 'y\n')
    writeFileSync(two, 'r\n')
    const stats = await fileHistoryGetDiffStats(h.state, m1)
    expect(stats!.filesChanged!.slice().sort()).toEqual([one, two].sort())
    expect(stats!.insertions).toBe(3)
    expect(stats!.deletions).toBe(2)
  })

  test('a file created after the target counts its lines as deletions', async () => {
    const abs = join(project, 'new.txt')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    writeFileSync(abs, 'l1\nl2\nl3\n')
    expect(await fileHistoryGetDiffStats(h.state, m1)).toEqual({
      filesChanged: [abs],
      insertions: 0,
      deletions: 3,
    })
  })

  test('a zero-byte file created after the target still counts as changed', async () => {
    const abs = join(project, 'empty.txt')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    writeFileSync(abs, '')
    expect(await fileHistoryGetDiffStats(h.state, m1)).toEqual({
      filesChanged: [abs],
      insertions: 0,
      deletions: 0,
    })
  })

  test('a null backup whose file is still absent is not a change', async () => {
    const abs = join(project, 'never.txt')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    expect(await fileHistoryGetDiffStats(h.state, m1)).toEqual({
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })
  })

  test('a deleted tracked file counts its backup lines as insertions', async () => {
    const abs = file('gone.txt', 'a\nb\n')
    const { h, m1 } = await editedUnder(abs, 'a\nb\n')
    unlinkSync(abs)
    expect(await fileHistoryGetDiffStats(h.state, m1)).toEqual({
      filesChanged: [abs],
      insertions: 2,
      deletions: 0,
    })
  })

  test('uses the v1 backup for a file tracked after the target; skips one with no v1', async () => {
    const abs = file('a.txt', 'one\n')
    file('orphan.txt', 'zzz\n')
    const h = holder()
    const m1 = msg()
    const m2 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryMakeSnapshot(h.update, m2)
    await fileHistoryTrackEdit(h.update, abs, m2)
    writeFileSync(abs, 'two\n')
    h.update(s => ({ ...s, trackedFiles: new Set([...s.trackedFiles, 'orphan.txt']) }))
    expect(await fileHistoryGetDiffStats(h.state, m1)).toEqual({
      filesChanged: [abs],
      insertions: 1,
      deletions: 1,
    })
  })

  test('an unknown message id gives undefined', async () => {
    expect(await fileHistoryGetDiffStats(emptyState(), msg())).toBeUndefined()
  })
})

describe('fileHistoryHasAnyChanges', () => {
  test('false when every tracked file matches the target', async () => {
    const abs = file('a.txt', 'a')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    expect(await fileHistoryHasAnyChanges(h.state, m1)).toBe(false)
  })

  test('true when a tracked file differs from its backup', async () => {
    const abs = file('a.txt', 'a')
    const { h, m1 } = await editedUnder(abs, 'b')
    expect(await fileHistoryHasAnyChanges(h.state, m1)).toBe(true)
  })

  test('true when a file absent at the target now exists, false while it stays absent', async () => {
    const abs = join(project, 'new.txt')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    expect(await fileHistoryHasAnyChanges(h.state, m1)).toBe(false)
    writeFileSync(abs, '')
    expect(await fileHistoryHasAnyChanges(h.state, m1)).toBe(true)
  })

  test('a file with no v1 anywhere is skipped; a v1 from a later snapshot is used', async () => {
    const abs = file('a.txt', 'one')
    file('orphan.txt', 'zzz')
    const h = holder()
    const m1 = msg()
    const m2 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryMakeSnapshot(h.update, m2)
    h.update(s => ({ ...s, trackedFiles: new Set(['orphan.txt']) }))
    expect(await fileHistoryHasAnyChanges(h.state, m1)).toBe(false)
    await fileHistoryTrackEdit(h.update, abs, m2)
    writeFileSync(abs, 'two')
    expect(await fileHistoryHasAnyChanges(h.state, m1)).toBe(true)
  })

  test('an unknown message id gives false', async () => {
    expect(await fileHistoryHasAnyChanges(emptyState(), msg())).toBe(false)
  })
})

describe('checkOriginFileChanged', () => {
  /** A backup at `name` under the session dir, with the given bytes. */
  function backup(name: string, content: string): string {
    const p = backupPath(name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
    return name
  }
  const name = () => `${randomUUID()}@v1`

  test('both missing: unchanged', async () => {
    expect(await checkOriginFileChanged(join(project, 'nope'), name())).toBe(false)
  })

  test('one side missing: changed', async () => {
    expect(await checkOriginFileChanged(join(project, 'nope'), backup(name(), 'x'))).toBe(true)
    expect(await checkOriginFileChanged(file('a.txt', 'x'), name())).toBe(true)
  })

  test('same bytes: unchanged; different size: changed', async () => {
    const b = backup(name(), 'abc')
    expect(await checkOriginFileChanged(file('a.txt', 'abc'), b)).toBe(false)
    expect(await checkOriginFileChanged(file('b.txt', 'abcd'), b)).toBe(true)
  })

  test('different mode: changed', async () => {
    const b = backup(name(), 'abc')
    const abs = file('a.txt', 'abc')
    chmodSync(abs, 0o600)
    chmodSync(backupPath(b), 0o644)
    expect(await checkOriginFileChanged(abs, b)).toBe(true)
  })

  test('same size, different bytes, written after the backup: changed', async () => {
    const b = backup(name(), 'abc')
    utimesSync(backupPath(b), OLD, OLD)
    expect(await checkOriginFileChanged(file('a.txt', 'xyz'), b)).toBe(true)
  })

  test('same size and mode, different bytes, mtime older than the backup: unchanged (current behavior)', async () => {
    const b = backup(name(), 'abc')
    const abs = file('a.txt', 'xyz')
    utimesSync(abs, OLD, OLD)
    expect(await checkOriginFileChanged(abs, b)).toBe(false)
  })

  test('a stats hint replaces the stat of the original', async () => {
    const b = backup(name(), 'abc')
    const abs = file('a.txt', 'abc')
    const hint = { ...statSync(abs), size: 99 } as Stats
    expect(await checkOriginFileChanged(abs, b, hint)).toBe(true)
  })

  test('a stat error other than ENOENT counts as changed', async () => {
    const parent = file('plain.txt', 'p')
    expect(await checkOriginFileChanged(join(parent, 'child'), name())).toBe(true)
    const b = `${basename(parent)}/child@v1` // backup path under a file: ENOTDIR
    mkdirSync(join(backupPath('x'), '..'), { recursive: true })
    writeFileSync(backupPath(basename(parent)), 'f')
    expect(await checkOriginFileChanged(file('c.txt', 'c'), b)).toBe(true)
  })
})
