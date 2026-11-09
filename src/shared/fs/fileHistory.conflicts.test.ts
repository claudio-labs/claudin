import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getIsInteractive, getOriginalCwd, setIsInteractive, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import {
  fileHistoryFindConflicts,
  fileHistoryForwardWritesOnly,
  fileHistoryMakeSnapshot,
  fileHistoryRecordWrite,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from 'src/shared/fs/fileHistory.js'

/**
 * Rewind conflicts: an agent write records what it left on disk
 * (fileHistoryRecordWrite), and a rewind's confirmation asks about every file
 * that has moved on since (fileHistoryFindConflicts), restoring the rest and
 * keeping those (fileHistoryRewind's `keep`). Same setup as
 * fileHistory.rewind.test.ts: real files in a temp project, backups under a
 * temp CLAUDIN_CONFIG_DIR, the session non-interactive so the SDK gate rules.
 */

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDIN_DISABLE_FILE_CHECKPOINTING'] as const
const savedEnv: Record<string, string | undefined> = {}
let savedCwd = ''
let savedInteractive = false
let root = ''
let project = ''

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  savedCwd = getOriginalCwd()
  savedInteractive = getIsInteractive()
  root = mkdtempSync(join(tmpdir(), 'fileHistoryConflicts-'))
  setOriginalFsImplementation()
})

beforeEach(() => {
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
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

function holder() {
  let state: FileHistoryState = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }
  return {
    update: (updater: Updater) => {
      state = updater(state)
    },
    get state() {
      return state
    },
  }
}

function file(rel: string, content: string): string {
  const abs = join(project, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

/** The tool order: trackEdit, the write, recordWrite — under message `m`. */
async function agentWrites(h: ReturnType<typeof holder>, m: UUID, abs: string, content: string | null): Promise<void> {
  await fileHistoryTrackEdit(h.update, abs, m)
  if (content === null) unlinkSync(abs)
  else writeFileSync(abs, content)
  await fileHistoryRecordWrite(h.update, abs)
}

/** m1 is submitted, the agent edits every file under it, then m2 is submitted. */
async function session(files: Record<string, string>) {
  const h = holder()
  const m1 = randomUUID()
  await fileHistoryMakeSnapshot(h.update, m1)
  for (const [abs, content] of Object.entries(files)) await agentWrites(h, m1, abs, content)
  await fileHistoryMakeSnapshot(h.update, randomUUID())
  return { h, m1 }
}

describe('fileHistoryRecordWrite', () => {
  test('fingerprints what a tracked file holds after the write', async () => {
    const abs = file('a.txt', 'one\n')
    const { h } = await session({ [abs]: 'two\n' })
    expect(Object.keys(h.state.lastWrites ?? {})).toEqual(['a.txt'])
    expect(h.state.lastWrites!['a.txt']).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a write that deleted the file records null', async () => {
    const abs = file('gone.txt', 'bye\n')
    const h = holder()
    const m1 = randomUUID()
    await fileHistoryMakeSnapshot(h.update, m1)
    await agentWrites(h, m1, abs, null)
    expect(h.state.lastWrites).toEqual({ 'gone.txt': null })
  })

  test('ignores a file nothing tracked', async () => {
    const h = holder()
    await fileHistoryMakeSnapshot(h.update, randomUUID())
    await fileHistoryRecordWrite(h.update, file('loose.txt', 'x'))
    expect(h.state.lastWrites).toBeUndefined()
  })

  test('does nothing with file history off', async () => {
    const h = holder()
    const m1 = randomUUID()
    await fileHistoryMakeSnapshot(h.update, m1)
    const abs = file('a.txt', 'one\n')
    await fileHistoryTrackEdit(h.update, abs, m1)
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    await fileHistoryRecordWrite(h.update, abs)
    expect(h.state.lastWrites).toBeUndefined()
  })

  test('a file it cannot read is skipped, not recorded', async () => {
    const h = holder()
    const m1 = randomUUID()
    await fileHistoryMakeSnapshot(h.update, m1)
    const dir = join(project, 'adir')
    mkdirSync(dir)
    await fileHistoryTrackEdit(h.update, dir, m1)
    await fileHistoryRecordWrite(h.update, dir)
    expect(h.state.lastWrites).toBeUndefined()
  })
})

describe('fileHistoryFindConflicts', () => {
  test('a file edited by hand after the agent wrote it is a conflict; an untouched one is not', async () => {
    const edited = file('edited.ts', 'v0\n')
    const untouched = file('untouched.ts', 'v0\n')
    const { h, m1 } = await session({ [edited]: 'agent\n', [untouched]: 'agent\n' })
    writeFileSync(edited, 'my manual edit\n')
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([edited])
  })

  test('a file deleted by hand after the agent wrote it is a conflict', async () => {
    const abs = file('a.ts', 'v0\n')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    unlinkSync(abs)
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([abs])
  })

  test('a file the agent created and someone removed is not: the rewind would delete it anyway', async () => {
    const abs = join(project, 'created.ts')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    unlinkSync(abs)
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([])
  })

  test('a file the agent created and someone edited is', async () => {
    const abs = join(project, 'created.ts')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    writeFileSync(abs, 'kept working on it\n')
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([abs])
  })

  test('a file put back by hand to the target content is not: the rewind would not touch it', async () => {
    const abs = file('a.ts', 'v0\n')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    writeFileSync(abs, 'v0\n')
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([])
  })

  test('a file with no write fingerprint is never a conflict', async () => {
    const abs = file('a.ts', 'v0\n')
    const recorded = file('recorded.ts', 'v0\n')
    const h = holder()
    const m1 = randomUUID()
    await fileHistoryMakeSnapshot(h.update, m1)
    await fileHistoryTrackEdit(h.update, abs, m1)
    writeFileSync(abs, 'agent, recorded nowhere\n')
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([])
    // Another file's fingerprint does not make this one's absence a conflict.
    await agentWrites(h, m1, recorded, 'agent\n')
    writeFileSync(abs, 'manual\n')
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([])
  })

  test('an unknown message, or file history off, finds none', async () => {
    const abs = file('a.ts', 'v0\n')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    writeFileSync(abs, 'manual\n')
    expect(await fileHistoryFindConflicts(h.state, randomUUID())).toEqual([])
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([])
  })

  test('a tracked file whose first version cannot be resolved is skipped', async () => {
    const abs = file('a.ts', 'v0\n')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    writeFileSync(abs, 'manual\n')
    const state: FileHistoryState = {
      ...h.state,
      snapshots: h.state.snapshots.map(s => ({ ...s, trackedFileBackups: {} })),
    }
    expect(await fileHistoryFindConflicts(state, m1)).toEqual([])
  })

  test('a file it cannot read is logged and skipped', async () => {
    const abs = file('a.ts', 'v0\n')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    unlinkSync(abs)
    mkdirSync(abs)
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([])
  })
})

describe('fileHistoryForwardWritesOnly', () => {
  test("forwards a write's fingerprint and nothing else: a sub-agent's edits are not checkpointed", async () => {
    const abs = file('a.ts', 'v0\n')
    const { h, m1 } = await session({ [abs]: 'main\n' })
    const backupsBefore = h.state.snapshots.at(-1)!.trackedFileBackups
    const forward = fileHistoryForwardWritesOnly(h.update)

    const other = file('other.ts', 'v0\n')
    await fileHistoryTrackEdit(forward, other, m1)
    await fileHistoryMakeSnapshot(forward, randomUUID())
    expect([...h.state.trackedFiles]).toEqual(['a.ts'])
    expect(h.state.snapshots.at(-1)!.trackedFileBackups).toBe(backupsBefore)

    writeFileSync(abs, 'sub-agent\n')
    await fileHistoryRecordWrite(forward, abs)
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([])
  })
})

describe('fileHistoryRewind with keep', () => {
  test('restores everything but the kept files', async () => {
    const kept = file('kept.ts', 'v0\n')
    const other = file('other.ts', 'v0\n')
    const { h, m1 } = await session({ [kept]: 'agent\n', [other]: 'agent\n' })
    writeFileSync(kept, 'my manual edit\n')

    await fileHistoryRewind(h.update, m1, { keep: new Set(await fileHistoryFindConflicts(h.state, m1)) })

    expect(readFileSync(kept, 'utf-8')).toBe('my manual edit\n')
    expect(readFileSync(other, 'utf-8')).toBe('v0\n')
  })

  test("refreshes the fingerprints of what it rewrote, so a second rewind does not mistake its own result for someone else's", async () => {
    const abs = file('a.ts', 'v0\n')
    const h = holder()
    const m1 = randomUUID()
    const m2 = randomUUID()
    await fileHistoryMakeSnapshot(h.update, m1)
    await agentWrites(h, m1, abs, 'v1\n')
    await fileHistoryMakeSnapshot(h.update, m2)
    await agentWrites(h, m2, abs, 'v2\n')
    await fileHistoryMakeSnapshot(h.update, randomUUID())

    await fileHistoryRewind(h.update, m2)
    expect(readFileSync(abs, 'utf-8')).toBe('v1\n')
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([])
  })

  test('a kept file keeps its old fingerprint, so it stays a conflict', async () => {
    const abs = file('a.ts', 'v0\n')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    writeFileSync(abs, 'manual\n')
    await fileHistoryRewind(h.update, m1, { keep: new Set([abs]) })
    expect(await fileHistoryFindConflicts(h.state, m1)).toEqual([abs])
  })

  test('a rewritten file that was deleted keeps a null fingerprint', async () => {
    const abs = join(project, 'created.ts')
    const { h, m1 } = await session({ [abs]: 'agent\n' })
    await fileHistoryRewind(h.update, m1)
    expect(existsSync(abs)).toBe(false)
    expect(h.state.lastWrites).toEqual({ 'created.ts': null })
  })
})
