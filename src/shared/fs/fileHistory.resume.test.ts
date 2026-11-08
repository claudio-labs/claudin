import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
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
  copyFileHistoryForResume,
  fileHistoryRestoreStateFromLog,
  type FileHistoryBackup,
  type FileHistorySnapshot,
  type FileHistoryState,
} from 'src/shared/fs/fileHistory.js'
import type { LogOption } from 'src/shared/types/logs.js'

/**
 * Characterization of the resume half of fileHistory.ts: rebuilding the state
 * from a transcript's snapshots, and carrying the previous session's backups
 * over to the new session id. The live half is in fileHistory.test.ts; the env
 * setup is the same (non-interactive, so CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING).
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
  root = mkdtempSync(join(tmpdir(), 'fileHistoryResume-'))
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

const bk = (backupFileName: string | null, version = 1): FileHistoryBackup => ({
  backupFileName,
  version,
  backupTime: new Date('2026-01-01T00:00:00Z'),
})

const snap = (backups: Record<string, FileHistoryBackup>): FileHistorySnapshot => ({
  messageId: randomUUID(),
  trackedFileBackups: backups,
  timestamp: new Date('2026-01-01T00:00:00Z'),
})

function restore(snapshots: FileHistorySnapshot[]): FileHistoryState | undefined {
  let got: FileHistoryState | undefined
  fileHistoryRestoreStateFromLog(snapshots, s => {
    got = s
  })
  return got
}

describe('fileHistoryRestoreStateFromLog', () => {
  test('shortens absolute paths under the cwd and rebuilds trackedFiles from every snapshot', () => {
    const outside = join(root, 'elsewhere.txt')
    const a = bk('a@v1')
    const b = bk(null)
    const logged = [
      snap({ [join(project, 'src/a.ts')]: a }),
      snap({ 'rel/b.ts': b, [outside]: bk('o@v1') }),
    ]
    const state = restore(logged)!

    expect(state.snapshots).toHaveLength(2)
    expect(state.snapshots[0]!.trackedFileBackups).toEqual({ 'src/a.ts': a })
    expect(state.snapshots[0]!.trackedFileBackups['src/a.ts']).toBe(a)
    expect(Object.keys(state.snapshots[1]!.trackedFileBackups)).toEqual(['rel/b.ts', outside])
    expect([...state.trackedFiles].sort()).toEqual(['rel/b.ts', 'src/a.ts', outside].sort())
    expect(state.snapshotSequence).toBe(2)
    expect(state.snapshots[0]!.messageId).toBe(logged[0]!.messageId)
    expect(state.snapshots[0]!.timestamp).toBe(logged[0]!.timestamp)
  })

  test('does not mutate the logged snapshots', () => {
    const abs = join(project, 'a.ts')
    const logged = [snap({ [abs]: bk('a@v1') })]
    restore(logged)
    expect(Object.keys(logged[0]!.trackedFileBackups)).toEqual([abs])
  })

  test('an empty log gives an empty state', () => {
    expect(restore([])).toEqual({ snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 })
  })

  test('a sibling dir sharing the cwd as a string prefix is shortened to ../ (current behavior)', () => {
    const sibling = `${project}-other/x.ts`
    const state = restore([snap({ [sibling]: bk('x@v1') })])!
    expect([...state.trackedFiles]).toEqual([`../${basename(project)}-other/x.ts`])
  })

  test('disabled: the callback is never called', () => {
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    expect(restore([snap({})])).toBeUndefined()
  })
})

describe('copyFileHistoryForResume', () => {
  function sessionDir(id: string): string {
    return join(configDir, 'file-history', id)
  }
  function prevBackup(prev: string, name: string, content: string): void {
    mkdirSync(sessionDir(prev), { recursive: true })
    writeFileSync(join(sessionDir(prev), name), content)
  }
  function log(snapshots: FileHistorySnapshot[] | undefined, sessionId?: string): LogOption {
    return {
      messages: sessionId === undefined ? [{}] : [{ sessionId }],
      fileHistorySnapshots: snapshots,
    } as unknown as LogOption
  }
  const uniq = () => `${randomUUID()}@v1`

  test('hard-links every non-null backup of the previous session into the current one', async () => {
    const prev = randomUUID()
    const one = uniq()
    const two = uniq()
    prevBackup(prev, one, 'one')
    prevBackup(prev, two, 'two')
    await copyFileHistoryForResume(
      log([snap({ 'a.ts': bk(one), 'gone.ts': bk(null) }), snap({ 'b.ts': bk(two, 2) })], prev),
    )
    const now = sessionDir(getSessionId())
    expect(readFileSync(join(now, one), 'utf-8')).toBe('one')
    expect(readFileSync(join(now, two), 'utf-8')).toBe('two')
    expect(statSync(join(now, one)).ino).toBe(statSync(join(sessionDir(prev), one)).ino)
  })

  test('a backup already migrated is kept as it is', async () => {
    const prev = randomUUID()
    const name = uniq()
    prevBackup(prev, name, 'from previous')
    mkdirSync(sessionDir(getSessionId()), { recursive: true })
    writeFileSync(join(sessionDir(getSessionId()), name), 'already here')
    await copyFileHistoryForResume(log([snap({ 'a.ts': bk(name) })], prev))
    expect(readFileSync(join(sessionDir(getSessionId()), name), 'utf-8')).toBe('already here')
  })

  test('a backup missing from the previous session is skipped without throwing', async () => {
    const prev = randomUUID()
    const present = uniq()
    const missing = uniq()
    prevBackup(prev, present, 'p')
    await copyFileHistoryForResume(
      log([snap({ 'a.ts': bk(missing) }), snap({ 'b.ts': bk(present) })], prev),
    )
    expect(existsSync(join(sessionDir(getSessionId()), missing))).toBe(false)
    expect(existsSync(join(sessionDir(getSessionId()), present))).toBe(true)
  })

  test('same session id, no previous id, no snapshots or no messages: nothing is copied', async () => {
    const name = uniq()
    const snaps = [snap({ 'a.ts': bk(name) })]
    prevBackup(getSessionId(), name, 'mine')
    await copyFileHistoryForResume(log(snaps, getSessionId()))
    await copyFileHistoryForResume(log(snaps))
    await copyFileHistoryForResume(log(undefined, randomUUID()))
    await copyFileHistoryForResume({ messages: [], fileHistorySnapshots: snaps } as unknown as LogOption)
    expect(readFileSync(join(sessionDir(getSessionId()), name), 'utf-8')).toBe('mine')
  })

  test('an unusable config dir is logged, not thrown', async () => {
    const blocker = join(root, `blocker-${randomUUID()}`)
    writeFileSync(blocker, 'not a dir')
    process.env.CLAUDIN_CONFIG_DIR = blocker
    await copyFileHistoryForResume(log([snap({ 'a.ts': bk(uniq()) })], randomUUID()))
    expect(readFileSync(blocker, 'utf-8')).toBe('not a dir')
  })

  test('disabled: nothing is copied', async () => {
    const prev = randomUUID()
    const name = uniq()
    prevBackup(prev, name, 'x')
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    await copyFileHistoryForResume(log([snap({ 'a.ts': bk(name) })], prev))
    expect(existsSync(join(sessionDir(getSessionId()), name))).toBe(false)
  })
})
