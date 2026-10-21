/**
 * A file the model had read and then changed with its own Bash command —
 * `python3 - <<'E' … open(p,'w').write(…)`, `sed -i`, `cat >> f <<'E'` — is
 * brought up to date in `readFileState` when the command ends, instead of
 * coming back on the next prompt as "modified, either by the user or by a
 * linter" with a snippet of the change.
 *
 * ## Why it exists
 *
 * The changed-files watcher (`agent/attachments/changedFile.ts`) compares
 * every entry with the disk on each user turn and has no way to tell who
 * changed a file. On Sonnet 5.5 neither CLI calls Edit or Patch in the
 * session A/B of 2026-10-09: both edit through `python3` heredocs. claudindev
 * had Read the files first, so the resumed prompt carried six such notes,
 * ~15k chars, which was the whole of its 7.2k-token resume write against
 * Claude Code's 855. The note says something false — the user did not make
 * that change — and the model already knows what it wrote.
 *
 * ## What it does
 *
 * After a Bash command that ran in the foreground, every entry whose file's
 * mtime is at or after the command's start, and past the entry's own, is
 * taken as changed by that command:
 *
 * - a whole-file entry gets the file's bytes and the new mtime;
 * - a range entry is re-verified slice by slice (`refreshRangeEntry`), which
 *   keeps the slices that still match and drops the rest;
 * - either is marked `dedupExempt`: Read's `file_unchanged` stub must never
 *   stand for bytes no Read showed.
 *
 * The result then names those files in one line (`readNote`), so the model
 * still learns which reads its command moved. Edit's "modified since read"
 * check passes on the new mtime; its `old_string` match is what still guards
 * the content.
 *
 * Known limit: a change someone else makes to a read file inside the
 * command's own run is taken as the command's. The window is the command's
 * runtime, and the line names the file.
 *
 * `CLAUDIN_BASH_OWN_WRITES=1` turns it on. Off by default until the session
 * A/B decides. Read per call, so a test can set it.
 */
import { relative } from 'path'
import {
  changedFileCandidates,
  isRangeEntry,
  refreshRangeEntry,
} from 'src/agent/attachments/changedFile.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isENOENT } from 'src/shared/errors.js'
import { getFileModificationTimeAsync } from 'src/shared/fs/file.js'
import type { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { expandPath } from 'src/shared/fs/path.js'
import { FileTooLargeError, readFileInRange } from 'src/shared/fs/readFileInRange.js'
import { logError } from 'src/shared/log.js'

/** Past this a whole-file entry is left to the watcher, which marks it too large to refresh. */
const OWN_WRITE_MAX_BYTES = 10 * 1024 * 1024

function isOwnWritesEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_BASH_OWN_WRITES)
}

export type OwnWrites = {
  /** Absolute paths of the read files the command changed. */
  readonly changed: readonly string[]
  /** The line the result carries, or null when nothing changed. */
  readonly note: string | null
}

const NONE: OwnWrites = { changed: [], note: null }

/** Brings each read file the command changed up to date; see the module comment. */
export async function refreshOwnWrites(
  readFileState: FileStateCache,
  startedAt: number,
  cwd: string,
): Promise<OwnWrites> {
  if (!isOwnWritesEnabled()) return NONE
  const changed: string[] = []
  await Promise.all(
    changedFileCandidates(readFileState).map(async ([cacheKey, state]) => {
      // A marker or an outline: the write tools refuse it whatever the disk holds.
      if (state.isPartialView || state.refreshFailed) return
      const path = expandPath(cacheKey)
      try {
        const mtime = await getFileModificationTimeAsync(path)
        if (mtime < startedAt || mtime <= state.timestamp) return
        if (isRangeEntry(state)) {
          // The diff it returns is the note this module exists to replace.
          await refreshRangeEntry(cacheKey, path, state, mtime, readFileState)
        } else {
          const { content } = await readFileInRange(path, 0, undefined, OWN_WRITE_MAX_BYTES)
          readFileState.set(cacheKey, {
            content,
            timestamp: mtime,
            offset: undefined,
            limit: undefined,
            dedupExempt: true,
          })
        }
        changed.push(path)
      } catch (err) {
        // Deleted, or grown past the cap: the watcher evicts or marks it on its next pass.
        if (isENOENT(err) || err instanceof FileTooLargeError) return
        logError(err)
      }
    }),
  )
  if (changed.length === 0) return NONE
  changed.sort()
  const names = changed.map(path => relative(cwd, path) || path).join(', ')
  const subject = changed.length === 1 ? '1 file you had read' : `${changed.length} files you had read`
  return { changed, note: `(${subject} changed under this command — your read now matches the disk: ${names})` }
}
