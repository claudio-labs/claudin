/**
 * Characterization of the consolidation lock (consolidationLock.ts), through
 * its five exports.
 *
 * The lock is one file in the auto-memory directory. Its modification time is
 * the moment of the last consolidation, and its body names the process that is
 * consolidating. Everything here is real: the memory directory and the
 * transcript directory live in a scratch tree, and "another process" is a real
 * child process.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  listSessionsTouchedSince,
  readLastConsolidatedAt,
  recordConsolidation,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from 'src/memory/autoDream/consolidationLock.js'
import { useScene } from 'src/memory/extract/__testutils__/extractionHarness.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'

const scene = useScene()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

/** The children a test started, stopped at its end. */
const children: Array<{ kill(): void }> = []

afterEach(() => {
  setSystemTime()
  for (const child of children.splice(0)) child.kill()
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  getAutoMemPath.cache.clear?.()
})

const lockFile = () => join(scene().memoryDir, '.consolidate-lock')

/** A whole second, so the time survives the file system's precision unchanged. */
const wholeSecond = (ms: number) => Math.floor(ms / 1000) * 1000

/** Writes a lock with the given body, last touched at `mtimeMs`. */
function plantLock(body: string, mtimeMs: number): void {
  mkdirSync(scene().memoryDir, { recursive: true })
  writeFileSync(lockFile(), body)
  utimesSync(lockFile(), mtimeMs / 1000, mtimeMs / 1000)
}

/** A lock body a reclaimer may meet, from the fixtures. */
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, 'locks', name), 'utf8')
}

/** The PID of a process that is alive until the test ends. */
function livePid(): number {
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  children.push(child)
  return child.pid
}

/** The PID of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true'])
  await child.exited
  return child.pid
}

/** Points the memory directory below a regular file, where it can never be created. */
function makeMemoryDirUncreatable(): string {
  const blocker = join(scene().root, 'not-a-directory')
  writeFileSync(blocker, 'a file')
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = join(blocker, 'memory')
  getAutoMemPath.cache.clear?.()
  return join(blocker, 'memory')
}

describe('readLastConsolidatedAt', () => {
  test('is 0 when no consolidation was ever recorded', async () => {
    expect(await readLastConsolidatedAt()).toBe(0)
  })

  test('is the modification time of .consolidate-lock in the memory directory, whatever its body', async () => {
    const when = wholeSecond(Date.now() - 3 * HOUR)
    for (const body of ['4242', '', 'garbage']) {
      plantLock(body, when)
      expect(await readLastConsolidatedAt()).toBe(when)
    }
  })

  test('a lock elsewhere does not count', async () => {
    mkdirSync(scene().memoryDir, { recursive: true })
    writeFileSync(join(scene().memoryDir, 'consolidate-lock'), '1')
    writeFileSync(join(scene().root, '.consolidate-lock'), '1')
    expect(await readLastConsolidatedAt()).toBe(0)
  })
})

describe('tryAcquireConsolidationLock', () => {
  test('with no lock it creates the memory directory and a lock holding exactly this PID, and answers 0', async () => {
    rmSync(scene().memoryDir, { recursive: true, force: true })
    const before = Date.now()
    expect(await tryAcquireConsolidationLock()).toBe(0)
    expect(readFileSync(lockFile(), 'utf8')).toBe(String(process.pid))
    expect(statSync(lockFile()).mtimeMs).toBeGreaterThanOrEqual(before - 1_000)
    expect(await readLastConsolidatedAt()).toBeGreaterThanOrEqual(before - 1_000)
  })

  test('takes over a lock it may reclaim, answering the time the lock had before', async () => {
    const cases: Array<{ name: string; body: () => Promise<string> | string; age: number }> = [
      { name: 'a dead holder, recent', body: async () => String(await deadPid()), age: 10 * MINUTE },
      { name: 'a live holder, an hour old', body: () => String(livePid()), age: HOUR + MINUTE },
      { name: 'our own PID, an hour old', body: () => String(process.pid), age: 2 * HOUR },
      { name: 'an empty body (a rolled-back lock)', body: () => readFixture('empty'), age: 5 * MINUTE },
      { name: 'a body that is no number', body: () => readFixture('garbled'), age: 5 * MINUTE },
      { name: 'PID 1, which never counts as a holder', body: () => readFixture('init-pid'), age: MINUTE },
      { name: 'a negative PID', body: () => '-7', age: MINUTE },
    ]
    for (const { name, body, age } of cases) {
      const before = wholeSecond(Date.now() - age)
      plantLock(await body(), before)
      const answer = await tryAcquireConsolidationLock()
      expect({ name, answer }).toEqual({ name, answer: before })
      expect({ name, body: readFileSync(lockFile(), 'utf8') }).toEqual({ name, body: String(process.pid) })
      expect(statSync(lockFile()).mtimeMs).toBeGreaterThan(before)
    }
  })

  test('backs off from a recent lock whose holder is alive, and leaves it as it was', async () => {
    const cases: Array<{ name: string; body: () => string }> = [
      { name: 'another live process', body: () => String(livePid()) },
      { name: 'this very process', body: () => String(process.pid) },
      { name: 'a live PID with whitespace around it', body: () => `  ${livePid()}\n` },
    ]
    for (const { name, body } of cases) {
      const before = wholeSecond(Date.now() - 20 * MINUTE)
      const text = body()
      plantLock(text, before)
      expect({ name, answer: await tryAcquireConsolidationLock() }).toEqual({ name, answer: null })
      expect(readFileSync(lockFile(), 'utf8')).toBe(text)
      expect(statSync(lockFile()).mtimeMs).toBe(before)
    }
  })

  test('a live holder is trusted for exactly one hour', async () => {
    const stamped = wholeSecond(Date.now() - 2 * HOUR)
    const holder = String(livePid())

    plantLock(holder, stamped)
    setSystemTime(new Date(stamped + HOUR - 1))
    expect(await tryAcquireConsolidationLock()).toBeNull()

    setSystemTime(new Date(stamped + HOUR))
    expect(await tryAcquireConsolidationLock()).toBe(stamped)
  })

  test('rejects when the memory directory cannot be created', async () => {
    makeMemoryDirUncreatable()
    await expect(tryAcquireConsolidationLock()).rejects.toThrow()
  })
})

describe('rollbackConsolidationLock', () => {
  test('to 0 removes the lock, so no consolidation is on record', async () => {
    await tryAcquireConsolidationLock()
    await rollbackConsolidationLock(0)
    expect(existsSync(lockFile())).toBe(false)
    expect(await readLastConsolidatedAt()).toBe(0)
  })

  test('to an earlier time puts that time back and empties the body', async () => {
    const earlier = wholeSecond(Date.now() - 30 * HOUR)
    plantLock('', earlier)
    await tryAcquireConsolidationLock()
    await rollbackConsolidationLock(earlier)
    expect(await readLastConsolidatedAt()).toBe(earlier)
    expect(readFileSync(lockFile(), 'utf8')).toBe('')
  })

  test('the emptied body frees the lock at once, even when the time put back is recent', async () => {
    const recent = wholeSecond(Date.now() - 10 * MINUTE)
    plantLock(String(process.pid), recent)
    expect(await tryAcquireConsolidationLock()).toBeNull()
    await rollbackConsolidationLock(recent)
    expect(await tryAcquireConsolidationLock()).toBe(recent)
  })

  test('with the lock gone, rolling back to a time writes an empty lock at that time', async () => {
    const earlier = wholeSecond(Date.now() - 26 * HOUR)
    mkdirSync(scene().memoryDir, { recursive: true })
    await rollbackConsolidationLock(earlier)
    expect(readFileSync(lockFile(), 'utf8')).toBe('')
    expect(await readLastConsolidatedAt()).toBe(earlier)
  })

  test('never rejects: nothing to remove, or nowhere to write', async () => {
    rmSync(scene().memoryDir, { recursive: true, force: true })
    await expect(rollbackConsolidationLock(0)).resolves.toBeUndefined()
    await expect(rollbackConsolidationLock(Date.now() - HOUR)).resolves.toBeUndefined()
    expect(existsSync(lockFile())).toBe(false)

    const unreachable = makeMemoryDirUncreatable()
    await expect(rollbackConsolidationLock(Date.now() - HOUR)).resolves.toBeUndefined()
    expect(existsSync(unreachable)).toBe(false)
  })
})

describe('recordConsolidation', () => {
  test('stamps the lock now with this PID, creating the memory directory', async () => {
    rmSync(scene().memoryDir, { recursive: true, force: true })
    const startedAt = Date.now()
    await expect(recordConsolidation()).resolves.toBeUndefined()
    expect(readFileSync(lockFile(), 'utf8')).toBe(String(process.pid))
    expect(await readLastConsolidatedAt()).toBeGreaterThanOrEqual(startedAt - 1_000)
  })

  test('overwrites a lock that another live process holds', async () => {
    const before = wholeSecond(Date.now() - 5 * MINUTE)
    plantLock(String(livePid()), before)
    await recordConsolidation()
    expect(readFileSync(lockFile(), 'utf8')).toBe(String(process.pid))
    expect(await readLastConsolidatedAt()).toBeGreaterThan(before)
  })

  test('swallows a failure to write', async () => {
    const unreachable = makeMemoryDirUncreatable()
    await expect(recordConsolidation()).resolves.toBeUndefined()
    expect(existsSync(unreachable)).toBe(false)
  })
})

describe('listSessionsTouchedSince', () => {
  const SESSIONS = [
    '3f0c2b1a-8d4e-4f6a-9b7c-1e2d3c4b5a60',
    '7a9e4d2c-1b3f-4e5d-8c6a-0f1e2d3c4b5a',
    'c41d8e7f-6a5b-4c3d-9e2f-1a0b9c8d7e6f',
  ]

  /** Copies the fixture transcripts into `dir`, every file touched at `mtimeMs`. */
  function plantTranscripts(dir: string, mtimeMs: number): void {
    cpSync(join(FIXTURES, 'transcripts'), dir, { recursive: true })
    for (const name of [
      ...SESSIONS.map(id => `${id}.jsonl`),
      'agent-a1b2c3d4e5f6.jsonl',
      'release-notes-draft.jsonl',
      '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.txt',
    ]) {
      utimesSync(join(dir, name), mtimeMs / 1000, mtimeMs / 1000)
    }
  }

  const touch = (dir: string, id: string, mtimeMs: number) =>
    utimesSync(join(dir, `${id}.jsonl`), mtimeMs / 1000, mtimeMs / 1000)

  test('lists the session transcripts of the project touched strictly after the given time', async () => {
    const dir = getProjectDir(getOriginalCwd())
    const since = wholeSecond(Date.now() - 6 * HOUR)
    plantTranscripts(dir, since + HOUR)
    touch(dir, SESSIONS[0]!, since)
    touch(dir, SESSIONS[1]!, since - HOUR)

    expect(await listSessionsTouchedSince(since)).toEqual([SESSIONS[2]])
    expect((await listSessionsTouchedSince(since - HOUR)).sort()).toEqual([SESSIONS[0], SESSIONS[2]])
    expect((await listSessionsTouchedSince(0)).sort()).toEqual([...SESSIONS].sort())
  })

  test('leaves out sub-agent transcripts, names that are no session id, and other files', async () => {
    const dir = getProjectDir(getOriginalCwd())
    plantTranscripts(dir, Date.now() - MINUTE)
    const listed = await listSessionsTouchedSince(0)
    expect(listed.sort()).toEqual([...SESSIONS].sort())
  })

  test('is empty when the project has no transcript directory', async () => {
    expect(existsSync(getProjectDir(getOriginalCwd()))).toBe(false)
    expect(await listSessionsTouchedSince(0)).toEqual([])
  })

  test('reads the directory of the original working directory', async () => {
    const elsewhere = join(scene().root, 'other-project')
    mkdirSync(elsewhere)
    setOriginalCwd(elsewhere)
    plantTranscripts(getProjectDir(elsewhere), Date.now() - MINUTE)
    expect((await listSessionsTouchedSince(0)).sort()).toEqual([...SESSIONS].sort())
    setOriginalCwd(scene().projectDir)
    expect(await listSessionsTouchedSince(0)).toEqual([])
  })
})
