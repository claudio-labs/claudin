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
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getIsInteractive,
  getOriginalCwd,
  getSessionId,
  setIsInteractive,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import {
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
  fileHistoryHasAnyChanges,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryBackup,
  type FileHistorySnapshot,
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
 * This file pins the write side (the gate, trackEdit, makeSnapshot). The
 * rewind side is fileHistory.rewind.test.ts and the resume half
 * (restoreStateFromLog, copyFileHistoryForResume) fileHistory.resume.test.ts;
 * each repeats this setup so its hooks register in its own scope.
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
  root = mkdtempSync(join(tmpdir(), 'fileHistory-'))
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

/** Submit m1, then the agent edits `abs` under m1 — the REPL's order. */
async function editedUnder(abs: string, content: string) {
  const h = holder()
  const m1 = msg()
  await fileHistoryMakeSnapshot(h.update, m1)
  await fileHistoryTrackEdit(h.update, abs, m1)
  writeFileSync(abs, content)
  return { h, m1 }
}

describe('fileHistoryEnabled', () => {
  test('non-interactive: on only with CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING', () => {
    expect(fileHistoryEnabled()).toBe(true)
    delete process.env.CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING
    expect(fileHistoryEnabled()).toBe(false)
  })

  test('non-interactive: CLAUDIN_DISABLE_FILE_CHECKPOINTING wins over the SDK switch', () => {
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    expect(fileHistoryEnabled()).toBe(false)
  })

  test('interactive: on by default config, off with CLAUDIN_DISABLE_FILE_CHECKPOINTING', () => {
    setIsInteractive(true)
    delete process.env.CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING
    expect(fileHistoryEnabled()).toBe(true)
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    expect(fileHistoryEnabled()).toBe(false)
  })

  test('disabled: every entry point is a no-op', async () => {
    const abs = file('a.txt', 'a\n')
    const { h, m1 } = await editedUnder(abs, 'b\n')
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    const before = h.state
    const calls = h.calls
    await fileHistoryTrackEdit(h.update, file('b.txt', 'x'), m1)
    await fileHistoryMakeSnapshot(h.update, msg())
    await fileHistoryRewind(h.update, msg()) // unknown id: no throw when disabled
    await fileHistoryRewind(h.update, m1)
    expect(h.calls).toBe(calls)
    expect(h.state).toBe(before)
    expect(readFileSync(abs, 'utf-8')).toBe('b\n')
    expect(fileHistoryCanRestore(h.state, m1)).toBe(false)
    expect(await fileHistoryGetDiffStats(h.state, m1)).toBeUndefined()
    expect(await fileHistoryHasAnyChanges(h.state, m1)).toBe(false)
  })
})

describe('fileHistoryTrackEdit', () => {
  test('backs up the pre-edit bytes as {sha256(path)[0:16]}@v1 in the latest snapshot', async () => {
    const abs = file('src/a.ts', 'original\n')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)

    const backup = h.state.snapshots[0]!.trackedFileBackups['src/a.ts']!
    expect(backup.backupFileName).toBe(backupName(abs, 1))
    expect(backup.version).toBe(1)
    expect(backup.backupTime).toBeInstanceOf(Date)
    expect([...h.state.trackedFiles]).toEqual(['src/a.ts'])
    expect(readFileSync(backupPath(backup.backupFileName!), 'utf-8')).toBe('original\n')
  })

  test('the backup keeps the file mode', async () => {
    const abs = file('run.sh', '#!/bin/sh\n')
    chmodSync(abs, 0o751)
    const { h } = await editedUnder(abs, '#!/bin/sh\necho\n')
    const name = h.state.snapshots[0]!.trackedFileBackups['run.sh']!.backupFileName!
    expect(statSync(backupPath(name)).mode & 0o777).toBe(0o751)
  })

  test('only the first edit per snapshot is backed up; v1 is never overwritten', async () => {
    const abs = file('a.txt', 'v0\n')
    const { h, m1 } = await editedUnder(abs, 'v1 after first edit\n')
    const before = h.state
    await fileHistoryTrackEdit(h.update, abs, m1)
    writeFileSync(abs, 'v2 after second edit\n')

    expect(h.state).toBe(before)
    expect(readFileSync(backupPath(backupName(abs, 1)), 'utf-8')).toBe('v0\n')
  })

  test('a file that did not exist backs up as null and is still tracked', async () => {
    const abs = join(project, 'new.txt')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    expect(h.state.snapshots[0]!.trackedFileBackups['new.txt']).toMatchObject({
      backupFileName: null,
      version: 1,
    })
    expect(h.state.trackedFiles.has('new.txt')).toBe(true)
  })

  test('a path outside the original cwd is tracked by its absolute path', async () => {
    const outside = join(root, `outside-${randomUUID()}.txt`)
    writeFileSync(outside, 'x')
    const { h } = await editedUnder(outside, 'y')
    expect([...h.state.trackedFiles]).toEqual([outside])
  })

  test('tracks into the most recent snapshot only, without mutating the old state', async () => {
    const abs = file('a.txt', 'a')
    const h = holder()
    const m1 = msg()
    const m2 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryMakeSnapshot(h.update, m2)
    const before = h.state
    const beforeLast = before.snapshots[1]!
    await fileHistoryTrackEdit(h.update, abs, m2)

    expect(h.state).not.toBe(before)
    expect(h.state.snapshots[0]).toBe(before.snapshots[0])
    expect(h.state.snapshots[0]!.trackedFileBackups).toEqual({})
    expect(Object.keys(h.state.snapshots[1]!.trackedFileBackups)).toEqual(['a.txt'])
    expect(beforeLast.trackedFileBackups).toEqual({})
    expect(before.trackedFiles.size).toBe(0)
  })

  test('two concurrent first edits of one file record a single backup', async () => {
    const abs = file('a.txt', 'a')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await Promise.all([
      fileHistoryTrackEdit(h.update, abs, m1),
      fileHistoryTrackEdit(h.update, abs, m1),
    ])
    expect(Object.keys(h.state.snapshots[0]!.trackedFileBackups)).toEqual(['a.txt'])
    expect(h.state.trackedFiles.size).toBe(1)
  })

  test('no snapshot yet: nothing is tracked', async () => {
    const h = holder()
    await fileHistoryTrackEdit(h.update, file('a.txt', 'a'), msg())
    expect(h.state).toEqual(emptyState())
  })

  test('an updater that never calls back (mcp.ts stub) is tolerated', async () => {
    await fileHistoryTrackEdit(() => {}, file('a.txt', 'a'), msg())
    await fileHistoryMakeSnapshot(() => {}, msg())
    await fileHistoryRewind(() => {}, msg())
  })

  test('a stat error other than ENOENT skips the edit without tracking it', async () => {
    const parent = file('plain.txt', 'p')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    const before = h.state
    await fileHistoryTrackEdit(h.update, join(parent, 'child.txt'), m1) // ENOTDIR
    expect(h.state).toBe(before)
  })
})

describe('fileHistoryMakeSnapshot', () => {
  test('appends a snapshot for the message and bumps snapshotSequence', async () => {
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    expect(h.state.snapshots).toHaveLength(1)
    expect(h.state.snapshots[0]!.messageId).toBe(m1)
    expect(h.state.snapshots[0]!.trackedFileBackups).toEqual({})
    expect(h.state.snapshots[0]!.timestamp).toBeInstanceOf(Date)
    expect(h.state.snapshotSequence).toBe(1)
  })

  test('a missing snapshotSequence counts from 0', async () => {
    const h = holder({
      snapshots: [],
      trackedFiles: new Set(),
    } as unknown as FileHistoryState)
    await fileHistoryMakeSnapshot(h.update, msg())
    expect(h.state.snapshotSequence).toBe(1)
  })

  test('an unchanged tracked file reuses the latest backup object', async () => {
    const abs = file('a.txt', 'same')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    const v1 = h.state.snapshots[0]!.trackedFileBackups['a.txt']
    await fileHistoryMakeSnapshot(h.update, msg())
    expect(h.state.snapshots[1]!.trackedFileBackups['a.txt']).toBe(v1)
    expect(existsSync(backupPath(backupName(abs, 2)))).toBe(false)
  })

  test('a changed tracked file gets the next version, and v1 is kept', async () => {
    const abs = file('a.txt', 'before\n')
    const { h } = await editedUnder(abs, 'after\n')
    await fileHistoryMakeSnapshot(h.update, msg())
    const v2 = h.state.snapshots[1]!.trackedFileBackups['a.txt']!
    expect(v2.version).toBe(2)
    expect(v2.backupFileName).toBe(backupName(abs, 2))
    expect(readFileSync(backupPath(v2.backupFileName!), 'utf-8')).toBe('after\n')
    expect(readFileSync(backupPath(backupName(abs, 1)), 'utf-8')).toBe('before\n')
  })

  test('a deleted tracked file is recorded as a null backup at the next version', async () => {
    const abs = file('a.txt', 'a')
    const { h } = await editedUnder(abs, 'b')
    unlinkSync(abs)
    await fileHistoryMakeSnapshot(h.update, msg())
    expect(h.state.snapshots[1]!.trackedFileBackups['a.txt']).toMatchObject({
      backupFileName: null,
      version: 2,
    })
  })

  test('a file created after a null backup is backed up at the next version', async () => {
    const abs = join(project, 'new.txt')
    const h = holder()
    const m1 = msg()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    writeFileSync(abs, 'created')
    await fileHistoryMakeSnapshot(h.update, msg())
    const v2 = h.state.snapshots[1]!.trackedFileBackups['new.txt']!
    expect(v2.version).toBe(2)
    expect(readFileSync(backupPath(v2.backupFileName!), 'utf-8')).toBe('created')
  })

  test('a tracked file absent from the latest snapshot starts again at v1', async () => {
    const abs = file('a.txt', 'a')
    const prior: FileHistorySnapshot = {
      messageId: msg(),
      trackedFileBackups: {},
      timestamp: new Date(),
    }
    const h = holder({ snapshots: [prior], trackedFiles: new Set(['a.txt']), snapshotSequence: 1 })
    await fileHistoryMakeSnapshot(h.update, msg())
    expect(h.state.snapshots[1]!.trackedFileBackups['a.txt']).toMatchObject({
      backupFileName: backupName(abs, 1),
      version: 1,
    })
  })

  test('a file tracked while the snapshot was in flight is inherited into it', async () => {
    const late: FileHistoryBackup = { backupFileName: null, version: 1, backupTime: new Date() }
    let state = emptyState()
    let calls = 0
    const m1 = msg()
    const update = (updater: Updater) => {
      calls++
      if (calls === 3) {
        // Between makeSnapshot's capture (call 2) and its commit (call 3).
        const last = state.snapshots.at(-1)!
        state = {
          ...state,
          trackedFiles: new Set([...state.trackedFiles, 'late.txt']),
          snapshots: [{ ...last, trackedFileBackups: { 'late.txt': late } }],
        }
      }
      state = updater(state)
    }
    update(s => ({ ...s, snapshots: [{ messageId: m1, trackedFileBackups: {}, timestamp: new Date() }] }))
    await fileHistoryMakeSnapshot(update, msg())
    expect(state.snapshots[1]!.trackedFileBackups['late.txt']).toBe(late)
  })

  test('a tracked file that fails to stat keeps its previous backup (current behavior)', async () => {
    file('plain.txt', 'p')
    const prev: FileHistoryBackup = { backupFileName: 'x@v1', version: 1, backupTime: new Date() }
    const h = holder({
      snapshots: [{ messageId: msg(), trackedFileBackups: { 'plain.txt/child': prev }, timestamp: new Date() }],
      trackedFiles: new Set(['plain.txt/child']),
      snapshotSequence: 1,
    })
    await fileHistoryMakeSnapshot(h.update, msg())
    expect(h.state.snapshots[1]!.trackedFileBackups['plain.txt/child']).toBe(prev)
  })

  test('keeps the last 100 snapshots while snapshotSequence keeps counting', async () => {
    const h = holder()
    const ids = Array.from({ length: 101 }, msg)
    for (const id of ids) await fileHistoryMakeSnapshot(h.update, id)
    expect(h.state.snapshots).toHaveLength(100)
    expect(h.state.snapshots[0]!.messageId).toBe(ids[1]!)
    expect(h.state.snapshots.at(-1)!.messageId).toBe(ids[100]!)
    expect(h.state.snapshotSequence).toBe(101)
    expect(fileHistoryCanRestore(h.state, ids[0]!)).toBe(false)
  })
})
