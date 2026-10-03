/**
 * The consolidation lock as its callers see it: the time of the last
 * consolidation, taking and giving back the lock, and the sessions touched
 * since. Only taking the lock may reject; the rest absorb their failures.
 */
import { join } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { isProcessRunning } from 'src/shared/proc/genericProcessUtils.js'
import { listCandidates } from 'src/sessions/sessionCandidates.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import {
  acquireLock,
  lastConsolidationTime,
  type LockDeps,
  rollBackLock,
  stampLock,
} from 'src/memory/autoDream/lock/lockFile.js'

const LOCK_FILE = '.consolidate-lock'

const HOLDER_STALE_MS = 60 * 60 * 1000

function lockPath(): string {
  return join(getAutoMemPath(), LOCK_FILE)
}

const lockDeps: LockDeps = {
  path: lockPath,
  now: () => Date.now(),
  pid: process.pid,
  isAlive: isProcessRunning,
  trustHolderForMs: HOLDER_STALE_MS,
}

function absorb(what: string): (error: unknown) => void {
  return error => logForDebugging(`[autoDream] ${what} failed: ${errorMessage(error)}`)
}

export async function readLastConsolidatedAt(): Promise<number> {
  try {
    return await lastConsolidationTime(lockDeps)
  } catch {
    return 0
  }
}

export async function tryAcquireConsolidationLock(): Promise<number | null> {
  return acquireLock(lockDeps)
}

export async function rollbackConsolidationLock(
  priorMtime: number,
): Promise<void> {
  await rollBackLock(priorMtime, lockDeps).catch(absorb('rolling back the lock'))
}

export async function listSessionsTouchedSince(
  sinceMs: number,
): Promise<string[]> {
  const candidates = await listCandidates(getProjectDir(getOriginalCwd()), true)
  return candidates
    .filter(candidate => candidate.mtime > sinceMs)
    .map(candidate => candidate.sessionId)
}

export async function recordConsolidation(): Promise<void> {
  await stampLock(lockDeps).catch(absorb('recording the consolidation'))
}
