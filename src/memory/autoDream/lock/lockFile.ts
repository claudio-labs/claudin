/**
 * The consolidation lock as a file on disk. Every process and every version
 * working on one memory directory shares it, so its format is stored data:
 * the modification time is the moment of the last consolidation, and the body
 * is the decimal PID of the process consolidating, or empty when none is.
 *
 * These operations report failures by rejecting; consolidationLock.ts decides
 * which of them its callers may see.
 */
import { randomUUID } from 'crypto'
import { link, mkdir, readFile, rename, stat, unlink, utimes, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, getErrnoCode, isENOENT } from 'src/shared/errors.js'

export type LockState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'free'; readonly at: number; readonly body: string }
  | { readonly kind: 'held'; readonly pid: number; readonly at: number; readonly body: string }

export type LockDeps = {
  readonly path: () => string
  readonly now: () => number
  readonly pid: number
  readonly isAlive: (pid: number) => boolean
  /** How long a live holder is believed; past it the PID may have been reused. */
  readonly trustHolderForMs: number
}

const LEADING_PID_RE = /^\d+/

function stateOf(at: number, body: string): LockState {
  const digits = LEADING_PID_RE.exec(body.trim())?.[0]
  return digits === undefined
    ? { kind: 'free', at, body }
    : { kind: 'held', pid: Number(digits), at, body }
}

async function snapshot(path: string): Promise<LockState> {
  try {
    const { mtimeMs } = await stat(path)
    return stateOf(mtimeMs, await readFile(path, 'utf8'))
  } catch {
    // A lock that cannot be read is no lock to respect. When the directory
    // itself is unusable, creating the lock is what reports it.
    return { kind: 'absent' }
  }
}

export function readLockState(deps: LockDeps): Promise<LockState> {
  return snapshot(deps.path())
}

/** The time of the last consolidation, or 0 when none is on record. */
export async function lastConsolidationTime(deps: LockDeps): Promise<number> {
  return (await stat(deps.path())).mtimeMs
}

function holderStillCounts(state: LockState, deps: LockDeps): boolean {
  if (state.kind !== 'held') return false
  return deps.now() - state.at < deps.trustHolderForMs && deps.isAlive(state.pid)
}

/** Creates the lock with this PID, unless some other process created it first. */
async function createExclusively(path: string, pid: number): Promise<boolean> {
  try {
    await writeFile(path, String(pid), { flag: 'wx' })
    return true
  } catch (error) {
    if (getErrnoCode(error) === 'EEXIST') return false
    throw error
  }
}

function sameLock(a: LockState, b: LockState): boolean {
  return a.kind !== 'absent' && b.kind !== 'absent' && a.at === b.at && a.body === b.body
}

/**
 * Takes the lock that was seen as `seen`, answering the time it had (0 when
 * there was none), or null when another process got there first.
 *
 * Exactly one claimant can win: a missing lock is created exclusively, and an
 * existing one is first moved aside, which only one rename can do. A claimant
 * whose observation is out of date moves a fresh lock aside instead, sees that
 * it is not the one it judged, and puts it back.
 *
 * While the old lock is aside there is no lock: a third process that looks
 * then creates one and is the single winner, with 0 as its time to roll back
 * to. A failed run of that winner then erases the record, costing one early
 * dream, never two at once.
 */
export async function claimLock(seen: LockState, deps: LockDeps): Promise<number | null> {
  const path = deps.path()
  if (seen.kind === 'absent') {
    await mkdir(dirname(path), { recursive: true })
    return (await createExclusively(path, deps.pid)) ? 0 : null
  }

  const aside = `${path}.${deps.pid}-${randomUUID()}`
  try {
    await rename(path, aside)
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
  try {
    const taken = await snapshot(aside)
    if (!sameLock(taken, seen)) {
      await link(aside, path).catch((error: unknown) =>
        logForDebugging(`[autoDream] could not put back a lock moved aside: ${errorMessage(error)}`),
      )
      return null
    }
    return (await createExclusively(path, deps.pid)) ? seen.at : null
  } finally {
    await unlink(aside).catch((error: unknown) =>
      logForDebugging(`[autoDream] could not remove ${aside}: ${errorMessage(error)}`),
    )
  }
}

export async function acquireLock(deps: LockDeps): Promise<number | null> {
  const seen = await readLockState(deps)
  if (holderStillCounts(seen, deps)) return null
  return claimLock(seen, deps)
}

/** 0 removes the lock; any other time empties its body and puts that time back. */
export async function rollBackLock(priorMtime: number, deps: LockDeps): Promise<void> {
  const path = deps.path()
  if (priorMtime === 0) {
    await unlink(path)
    return
  }
  await writeFile(path, '')
  const seconds = priorMtime / 1000
  await utimes(path, seconds, seconds)
}

/** Stamps the lock now with this PID, whoever holds it. */
export async function stampLock(deps: LockDeps): Promise<void> {
  const path = deps.path()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, String(deps.pid))
}
