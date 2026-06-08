import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getClaudinConfigHomeDir } from 'src/utils/envUtils.js'
import { isENOENT } from 'src/utils/errors.js'
import { logForDebugging } from 'src/utils/debug.js'

const CACHE_FILENAME = 'latest-version.json'

export type LatestVersionCache = {
  latest: string
  checkedAt: number
  current: string
}

function getCachePath(): string {
  return join(getClaudinConfigHomeDir(), CACHE_FILENAME)
}

function isValidCache(value: unknown): value is LatestVersionCache {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.latest === 'string' &&
    v.latest.length > 0 &&
    typeof v.current === 'string' &&
    v.current.length > 0 &&
    typeof v.checkedAt === 'number' &&
    Number.isFinite(v.checkedAt)
  )
}

/**
 * Synchronously read the latest-version cache. Returns null on missing file,
 * unreadable file, or invalid JSON — never throws. Used from the Ink startup
 * banner where async I/O would force an extra render pass.
 */
export function readLatestVersion(): LatestVersionCache | null {
  try {
    const raw = readFileSync(getCachePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isValidCache(parsed) ? parsed : null
  } catch (err) {
    if (isENOENT(err)) return null
    // Non-ENOENT errors (permission denied, EISDIR, JSON parse failure) are
    // recoverable from the caller's perspective — return null so the banner
    // simply omits the notice — but log via debug so postmortems can find
    // the cause. Mirrors the policy applied to writeLatestVersion's
    // listener-error path.
    logForDebugging(
      `latestVersionCache: read failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    )
    return null
  }
}

/**
 * Pub/sub so the Ink StartupBanner can re-render the moment the background
 * `runStartupUpdateCheck` writes a fresh cache. Without this, the banner
 * shows the stale snapshot from the previous launch and the new "version
 * available" line only appears on the *next* startup.
 */
const listeners = new Set<(cache: LatestVersionCache) => void>()

export function subscribeLatestVersion(
  listener: (cache: LatestVersionCache) => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Persist the latest-version cache. Best-effort: failures are logged via the
 * caller; this function only swallows ENOENT after creating the directory.
 */
export async function writeLatestVersion(
  cache: LatestVersionCache,
): Promise<void> {
  const path = getCachePath()
  const body = JSON.stringify(cache)
  try {
    await writeFile(path, body, 'utf8')
  } catch (err) {
    if (isENOENT(err)) {
      await mkdir(getClaudinConfigHomeDir(), { recursive: true })
      await writeFile(path, body, 'utf8')
    } else {
      throw err
    }
  }
  // Notify subscribers *after* the write succeeds so the banner re-render
  // is guaranteed to see the value on the next readLatestVersion() call.
  // Snapshot before iterating so a listener that subscribes/unsubscribes
  // during dispatch (e.g. React useEffect cleanup) doesn't mutate the set
  // we're iterating over.
  for (const listener of [...listeners]) {
    try {
      listener(cache)
    } catch (err) {
      // A bad listener must never block other subscribers or the write
      // path. Log via debug so the failure is recoverable in postmortems.
      logForDebugging(
        `latestVersionCache: listener threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      )
    }
  }
}
