/**
 * The reclaim of the lock (finding 6): of several processes that judge the
 * same lock free to take, exactly one takes it, and the file keeps its format.
 * "Processes" are claimants with their own PID over one real directory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireLock, claimLock, type LockDeps, readLockState } from 'src/memory/autoDream/lock/lockFile.js'

const HOUR = 60 * 60 * 1000
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dream-lock-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lockPath = () => join(dir, 'memory', '.consolidate-lock')

/** A claimant with its own PID; every PID but `dead` is alive. */
const claimant = (pid: number, dead = 0): LockDeps => ({
  path: lockPath,
  now: () => Date.now(),
  pid,
  isAlive: candidate => candidate > 1 && candidate !== dead,
  trustHolderForMs: HOUR,
})

function plantStaleLock(body: string): number {
  const at = Math.floor((Date.now() - 2 * HOUR) / 1000) * 1000
  const path = lockPath()
  rmSync(join(dir, 'memory'), { recursive: true, force: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(path, body)
  utimesSync(path, at / 1000, at / 1000)
  return at
}

const lockBody = () => readFileSync(lockPath(), 'utf8')
const leftovers = () => readdirSync(join(dir, 'memory')).filter(name => name !== '.consolidate-lock')

describe('claimLock, when two claimants judged the same lock', () => {
  test('a stale lock: the claimant that comes second backs off and leaves the winner its lock', async () => {
    const before = plantStaleLock('4242')
    const late = claimant(2002, 4242)
    const seenByLate = await readLockState(late)

    expect(await acquireLock(claimant(1001, 4242))).toBe(before)
    const winnersLock = { body: lockBody(), at: statSync(lockPath()).mtimeMs }

    expect(await claimLock(seenByLate, late)).toBeNull()
    expect({ body: lockBody(), at: statSync(lockPath()).mtimeMs }).toEqual(winnersLock)
    expect(winnersLock.body).toBe('1001')
    expect(leftovers()).toEqual([])
  })

  test('no lock: only one of them creates it', async () => {
    const late = claimant(2002)
    const seenByLate = await readLockState(late)
    expect(seenByLate).toEqual({ kind: 'absent' })

    expect(await acquireLock(claimant(1001))).toBe(0)
    expect(await claimLock(seenByLate, late)).toBeNull()
    expect(lockBody()).toBe('1001')
  })
})

describe('acquireLock, many claimants at once', () => {
  test('exactly one of them wins a free lock, and its PID is the body', async () => {
    for (let round = 0; round < 5; round++) {
      const before = plantStaleLock('')
      const pids = Array.from({ length: 8 }, (_, i) => 3000 + i)
      const answers = await Promise.all(pids.map(pid => acquireLock(claimant(pid))))
      const winners = pids.filter((_, i) => answers[i] !== null)
      expect({ round, winners: winners.length }).toEqual({ round, winners: 1 })
      // A claimant that looks while the winner has the old lock moved aside
      // sees none, creates it, and wins with 0 as the time to roll back to.
      expect([before, 0]).toContain(answers.find(answer => answer !== null) ?? -1)
      expect(lockBody()).toBe(String(winners[0]))
      expect(leftovers()).toEqual([])
    }
  })
})
