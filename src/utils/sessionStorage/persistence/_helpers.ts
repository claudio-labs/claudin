/**
 * Internal helpers shared by persistence/* modules.
 *
 * Extracted in Wave 3 of the 11c sessionStorage split. These were previously
 * file-private helpers inside `src/utils/sessionStorage.ts` (appendEntryToFile,
 * readFileTailSync). They become module-internal cross-module imports now
 * because record.ts and metadata.ts need to append entries directly without
 * routing through the Project singleton (e.g. saveCustomTitle writes to an
 * arbitrary sessionId's file, not the current Project's sessionFile).
 *
 * Not re-exported from the public barrel.
 */
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { dirname } from 'path'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { LITE_READ_BUF_SIZE } from 'src/utils/sessionStoragePortable.js'
import { jsonStringify } from 'src/utils/slowOperations.js'

/**
 * Append an entry to a session file. Creates the parent dir if missing.
 */
/* eslint-disable custom-rules/no-sync-fs -- sync callers (exit cleanup, materialize) */
export function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch (firstErr) {
    // Two-stage fallback: parent dir may not exist yet (first write of a
    // session) OR file may exist with a mode mismatch that confuses the
    // fsOps 'ax' fast-path under Bun. `recursive: true` keeps mkdirSync
    // idempotent. The second append intentionally omits `mode` so it never
    // takes the create-exclusive branch in the wrapper — the file is
    // guaranteed to already exist after a failed mode-tagged append.
    try {
      fs.mkdirSync(dirname(fullPath), { recursive: true, mode: 0o700 })
    } catch {
      throw firstErr
    }
    fs.appendFileSync(fullPath, line)
  }
}

/**
 * Sync tail read for reAppendSessionMetadata's external-writer check.
 * fstat on the already-open fd (no extra path lookup); reads the same
 * LITE_READ_BUF_SIZE window that readLiteMetadata scans. Returns empty
 * string on any error so callers fall through to unconditional behavior.
 */
export function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, 'r')
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(
      Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset),
    )
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // closeSync can throw; swallow to preserve return '' contract
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */
