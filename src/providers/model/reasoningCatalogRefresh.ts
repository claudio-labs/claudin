/**
 * Opt-in freshness for the reasoning catalog.
 *
 * The vendored snapshot (reasoningCatalogData.ts) is regenerated when someone
 * runs `bun run codegen:reasoning-catalog`, so a model published after the
 * last release has no effort levels until the next one. Setting
 * `CLAUDIN_MODELS_CATALOG_REFRESH=1` lets the session read a locally cached
 * copy of models.dev instead, and refresh that copy in the background when it
 * is older than a day.
 *
 * Off by default, and off means off: no file is read, no request is made. That
 * is the same stance as the rest of the fork's startup traffic — nothing
 * phones anywhere unless asked. When it IS on, the download carries no
 * request body, no credentials and no identifying parameters; it is a GET of a
 * public JSON file.
 *
 * A refresh takes effect on the NEXT session, deliberately. The lookup it
 * feeds is synchronous and sits on the picker's path; making it await a
 * network round trip would trade a stale level list for a stalled UI.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  trimModelsDevCatalog,
  type TrimmedCatalog,
} from 'src/providers/model/reasoningCatalogTrim.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getClaudinConfigHomeDir, isEnvTruthy } from 'src/shared/envUtils.js'
import { logError } from 'src/shared/log.js'

const SOURCE_URL = 'https://models.dev/api.json'
const CACHE_FILE = 'reasoning-catalog.json'
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

type CachedCatalog = {
  fetchedAt: number
  catalog: TrimmedCatalog
}

function isCatalogRefreshEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_MODELS_CATALOG_REFRESH)
}

function cachePath(): string {
  return join(getClaudinConfigHomeDir(), CACHE_FILE)
}

function readCache(): CachedCatalog | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<CachedCatalog>
    if (
      typeof parsed?.fetchedAt !== 'number' ||
      !parsed.catalog ||
      typeof parsed.catalog !== 'object'
    ) {
      return undefined
    }
    return parsed as CachedCatalog
  } catch {
    // Absent or unreadable is the normal first-run state, not an error.
    return undefined
  }
}

let refreshScheduled = false

function scheduleRefresh(): void {
  if (refreshScheduled) return
  refreshScheduled = true
  void (async () => {
    try {
      const response = await fetch(SOURCE_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        logForDebugging(`[ReasoningCatalog] ${SOURCE_URL} answered ${response.status}`)
        return
      }
      const catalog = trimModelsDevCatalog(await response.json())
      const payload: CachedCatalog = { fetchedAt: Date.now(), catalog }
      writeFileSync(cachePath(), JSON.stringify(payload), 'utf8')
      logForDebugging(
        `[ReasoningCatalog] refreshed ${Object.keys(catalog.efforts).length} providers`,
      )
    } catch (e) {
      // A stale catalog is a worse level list, never a broken session.
      logError(e)
      logForDebugging('[ReasoningCatalog] refresh failed')
    }
  })()
}

let resolved: TrimmedCatalog | undefined | null = null

/**
 * The cached catalog, when the opt-in is on and a cache exists. Memoized for
 * the process — the file is written by a background task whose result is meant
 * for the next session, so re-reading it mid-session would hand two different
 * level lists to two calls in the same picker.
 */
export function getRefreshedCatalog(): TrimmedCatalog | undefined {
  if (!isCatalogRefreshEnabled()) return undefined
  if (resolved !== null) return resolved

  const cached = readCache()
  resolved = cached?.catalog
  if (!cached || Date.now() - cached.fetchedAt > TTL_MS) {
    scheduleRefresh()
  }
  return resolved
}
