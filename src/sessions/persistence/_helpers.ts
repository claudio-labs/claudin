/**
 * Internal helpers shared by persistence/* modules.
 *
 * Extracted in Wave 3 of the 11c sessionStorage split. These were previously
 * file-private helpers inside `src/sessions/sessionStorage.ts` (appendEntryToFile,
 * readFileTailSync). They become module-internal cross-module imports now
 * because record.ts and metadata.ts need to append entries directly without
 * routing through the Project singleton (e.g. saveCustomTitle writes to an
 * arbitrary sessionId's file, not the current Project's sessionFile).
 *
 * Not re-exported from the public barrel.
 */
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { dirname } from 'path'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { LITE_READ_BUF_SIZE } from 'src/sessions/sessionStoragePortable.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { appendPrivateSync, readTailSync } from 'src/sessions/persistence/writer/privateFiles.js'

/** One line, written synchronously; a new file is owner-only (finding 1). */
export function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  appendPrivateSync(fullPath, `${jsonStringify(entry)}\n`)
}

/** The part of the file the session list reads, or '' when there is none. */
export function readFileTailSync(fullPath: string): string {
  return readTailSync(fullPath, LITE_READ_BUF_SIZE)
}
