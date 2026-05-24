import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getClaudioConfigHomeDir } from 'src/utils/envUtils.js'
import { isENOENT } from 'src/utils/errors.js'

const CACHE_FILENAME = 'latest-version.json'

export type LatestVersionCache = {
  latest: string
  checkedAt: number
  current: string
}

function getCachePath(): string {
  return join(getClaudioConfigHomeDir(), CACHE_FILENAME)
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
    return null
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
      await mkdir(getClaudioConfigHomeDir(), { recursive: true })
      await writeFile(path, body, 'utf8')
      return
    }
    throw err
  }
}
