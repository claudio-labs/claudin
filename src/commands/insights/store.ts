/**
 * Everything the report reads from and writes to disk: the three directories
 * under the config home, the two JSON caches that let a second run skip both
 * the JSONL parse and the facet extraction, and the metadata-only scan that
 * finds the session files in the first place.
 *
 * The cache readers fail closed — an unreadable or malformed file is a miss,
 * not an error, and a malformed facet file is deleted so the next run
 * re-extracts it.
 */
import type { Dirent } from 'fs'
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  isValidSessionFacets,
  type LiteSessionInfo,
  type SessionFacets,
  type SessionMeta,
} from 'src/commands/insights/types.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'
import {
  getProjectsDir,
  getSessionFilesWithMtime,
} from 'src/sessions/sessionStorage.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'

// Lazy getters: getClaudinConfigHomeDir() is memoized and reads process.env.
// Calling it at module scope would populate the memoize cache before
// entrypoints can set CLAUDIN_CONFIG_DIR, breaking all 150+ other callers.
export function getDataDir(): string {
  return join(getClaudinConfigHomeDir(), 'usage-data')
}
export function getFacetsDir(): string {
  return join(getDataDir(), 'facets')
}
function getSessionMetaDir(): string {
  return join(getDataDir(), 'session-meta')
}

export async function loadCachedFacets(
  sessionId: string,
): Promise<SessionFacets | null> {
  const facetPath = join(getFacetsDir(), `${sessionId}.json`)
  try {
    const content = await readFile(facetPath, { encoding: 'utf-8' })
    const parsed: unknown = jsonParse(content)
    if (!isValidSessionFacets(parsed)) {
      // Delete corrupted cache file so it gets re-extracted next run
      try {
        await unlink(facetPath)
      } catch {
        // Ignore deletion errors
      }
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function saveFacets(facets: SessionFacets): Promise<void> {
  try {
    await mkdir(getFacetsDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
  const facetPath = join(getFacetsDir(), `${facets.session_id}.json`)
  await writeFile(facetPath, jsonStringify(facets, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

export async function loadCachedSessionMeta(
  sessionId: string,
): Promise<SessionMeta | null> {
  const metaPath = join(getSessionMetaDir(), `${sessionId}.json`)
  try {
    const content = await readFile(metaPath, { encoding: 'utf-8' })
    return jsonParse(content)
  } catch {
    return null
  }
}

export async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  try {
    await mkdir(getSessionMetaDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
  const metaPath = join(getSessionMetaDir(), `${meta.session_id}.json`)
  await writeFile(metaPath, jsonStringify(meta, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

// ============================================================================
// Lite Session Scanning
// ============================================================================

/**
 * Scans all project directories using filesystem metadata only (no JSONL parsing).
 * Returns a list of session file info sorted by mtime descending.
 * Yields to the event loop between project directories to keep the UI responsive.
 */
export async function scanAllSessions(): Promise<LiteSessionInfo[]> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const allSessions: LiteSessionInfo[] = []

  for (let i = 0; i < projectDirs.length; i++) {
    const sessionFiles = await getSessionFilesWithMtime(projectDirs[i]!)
    for (const [sessionId, fileInfo] of sessionFiles) {
      allSessions.push({
        sessionId,
        path: fileInfo.path,
        mtime: fileInfo.mtime,
        size: fileInfo.size,
      })
    }
    // Yield to event loop every 10 project directories
    if (i % 10 === 9) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  // Sort by mtime descending (most recent first)
  allSessions.sort((a, b) => b.mtime - a.mtime)
  return allSessions
}
