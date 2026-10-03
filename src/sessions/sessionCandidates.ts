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
  projectPath?: string
}

const TRANSCRIPT_SUFFIX = '.jsonl'

/** The session id a directory entry names, when it is `<uuid>.jsonl`. */
function sessionIdOf(name: string): string | undefined {
  if (!name.endsWith(TRANSCRIPT_SUFFIX)) return undefined
  const stem = name.slice(0, -TRANSCRIPT_SUFFIX.length)
  return validateUuid(stem) ? stem : undefined
}

export async function listCandidates(
  projectDir: string,
  doStat: boolean,
  projectPath?: string,
): Promise<Candidate[]> {
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch {
    // A project without a readable session store simply has no candidates.
    return []
  }
  const named = names.flatMap((name): Candidate[] => {
    const sessionId = sessionIdOf(name)
    return sessionId ? [{ sessionId, filePath: join(projectDir, name), mtime: 0, projectPath }] : []
  })
  if (!doStat) return named
  const stamped = await Promise.all(
    named.map(async (candidate): Promise<Candidate | undefined> => {
      try {
        return { ...candidate, mtime: (await stat(candidate.filePath)).mtime.getTime() }
      } catch {
        // Gone or dangling since the listing: not a session to count.
        return undefined
      }
    }),
  )
  return stamped.filter((candidate): candidate is Candidate => candidate !== undefined)
}
