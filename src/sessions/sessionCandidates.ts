/**
 * Candidate discovery over the session store: one readdir, optionally one
 * stat per file, no content reads.
 *
 * Deliberately portable — no bootstrap/state.ts, no execa, no module-scope
 * mutable state — so a caller can import it without triggering CLI
 * initialization or pulling in an expensive dependency chain.
 *
 * This file used to be `listSessionsImpl.ts` and to carry the Agent SDK's
 * listSessions implementation. Nothing could reach that from either side: the
 * build has a single entrypoint, and the SDK's own `listSessions()` throws
 * `listSessions is not implemented in the SDK` rather than calling it.
 */

import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { validateUuid } from 'src/sessions/sessionStoragePortable.js'

type Candidate = {
  sessionId: string
  filePath: string
  mtime: number
  /** Project path for cwd fallback when file lacks a cwd field. */
  projectPath?: string
}

/**
 * Lists candidate session files in a directory via readdir, optionally
 * stat'ing each for mtime. When `doStat` is false, mtime is set to 0
 * (caller must sort/dedup after reading file contents instead).
 */
export async function listCandidates(
  projectDir: string,
  doStat: boolean,
  projectPath?: string,
): Promise<Candidate[]> {
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch {
    return []
  }

  const results = await Promise.all(
    names.map(async (name): Promise<Candidate | null> => {
      if (!name.endsWith('.jsonl')) return null
      const sessionId = validateUuid(name.slice(0, -6))
      if (!sessionId) return null
      const filePath = join(projectDir, name)
      if (!doStat) return { sessionId, filePath, mtime: 0, projectPath }
      try {
        const s = await stat(filePath)
        return { sessionId, filePath, mtime: s.mtime.getTime(), projectPath }
      } catch {
        return null
      }
    }),
  )

  return results.filter((c): c is Candidate => c !== null)
}
