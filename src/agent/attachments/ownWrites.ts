/**
 * A read file that changed while the model's own tool call ran is that call's:
 * when the call settles — returned, threw or was interrupted — its
 * `readFileState` entry is brought up to date and the result names the file,
 * instead of the next prompt reporting it as "modified, either by the user or
 * by a linter" with a snippet of the change.
 *
 * ## Why it exists
 *
 * The changed-files watcher (`changedFile.ts`) compares every entry with the
 * disk after each tool batch and on each user turn, and has no way to tell who
 * changed a file. In real traffic (census of 2026-10-21) 95% of its 2,146
 * notes followed one of the model's own calls: python or sed edits through
 * Bash, `git checkout`/`stash`/`rebase`, a build that rewrites sources in
 * place, `bun test` writing fixtures, a formatter, an inline sub-agent's
 * edits. The note says something false — the user did not make that change —
 * and carries a snippet the model did not need: ~4.5M chars over the census.
 *
 * ## What it does
 *
 * `settleOwnWrites` runs in the tool loop (`toolExecution.ts`) once per call,
 * before the PostToolUse hooks: a formatter hook's change stays the watcher's,
 * where "by a linter" is true. It skips a call that cannot change files —
 * `mayChangeFiles(input)`, else `!isReadOnly(input)` — so a change landing
 * during a Read is still reported. Every entry whose file's mtime is at or
 * after the call's start, and past the entry's own, is taken as changed by
 * the call:
 *
 * - a whole-file entry gets the file's bytes and the new mtime;
 * - a range entry is re-verified slice by slice (`refreshRangeEntry`), which
 *   keeps the slices that still match and drops the rest;
 * - either is marked `dedupExempt`: Read's `file_unchanged` stub must never
 *   stand for bytes no Read showed.
 *
 * The result then names those files in one line, and the tool_result message
 * carries their paths (`refreshedFiles`), from which `/resume` rebuilds the
 * same entries (`queryHelpers.ts`). Names only, never a diff: the call was the
 * model's, and a Read shows the content when it is needed. Edit's "modified
 * since read" check passes on the new mtime; its `old_string` match is what
 * still guards the content.
 *
 * Known limit: a change someone else makes to a read file inside the call's
 * own run is taken as the call's. The window is the call's runtime — for an
 * inline sub-agent, the whole agent — and the line names the file. A
 * background command or agent goes on writing after its call returned; those
 * changes stay the watcher's.
 *
 * `CLAUDIN_OWN_WRITES=1` turns it on. Off by default until the session A/B
 * decides. Read per call, so a test can set it.
 */
import {
  changedFileCandidates,
  isRangeEntry,
  refreshRangeEntry,
} from 'src/agent/attachments/changedFile.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isENOENT } from 'src/shared/errors.js'
import { getFileModificationTimeAsync } from 'src/shared/fs/file.js'
import type { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { expandPath, relativeIfInside } from 'src/shared/fs/path.js'
import { FileTooLargeError, readFileInRange } from 'src/shared/fs/readFileInRange.js'
import { logError } from 'src/shared/log.js'
import type { Tool } from 'src/tools/Tool.js'

/** Past this a whole-file entry is left to the watcher, which marks it too large to refresh. */
const OWN_WRITE_MAX_BYTES = 10 * 1024 * 1024

function isOwnWritesEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_OWN_WRITES)
}

export type OwnWrites = {
  /** Absolute paths of the read files the command changed. */
  readonly changed: readonly string[]
  /** The line the result carries, or null when nothing changed. */
  readonly note: string | null
}

const NONE: OwnWrites = { changed: [], note: null }

/** What the tool loop asks of a tool to know whether its call may have changed files. */
export type FileChangingTool = Pick<Tool, 'isReadOnly' | 'mayChangeFiles'>

function mayChangeFiles(tool: FileChangingTool, input: unknown): boolean {
  try {
    return tool.mayChangeFiles?.(input as never) ?? !tool.isReadOnly(input as never)
  } catch (err) {
    logError(err)
    // As buildTool's default for isReadOnly: assume it writes.
    return true
  }
}

/** The tool loop's entry: claims for this call what changed while it ran; see the module comment. */
export async function settleOwnWrites(
  tool: FileChangingTool,
  input: unknown,
  readFileState: FileStateCache,
  startedAt: number,
  cwd: string,
): Promise<OwnWrites> {
  if (!isOwnWritesEnabled() || !mayChangeFiles(tool, input)) return NONE
  try {
    return await refreshOwnWrites(readFileState, startedAt, cwd)
  } catch (err) {
    // Fail open: the watcher reports the change, as it did before.
    logError(err)
    return NONE
  }
}

/** Brings each read file the call changed up to date; see the module comment. */
export async function refreshOwnWrites(
  readFileState: FileStateCache,
  startedAt: number,
  cwd: string,
): Promise<OwnWrites> {
  if (!isOwnWritesEnabled()) return NONE
  // Collected in the cache's order, not in the order the stats come back.
  const refreshed = await Promise.all(
    changedFileCandidates(readFileState).map(async ([cacheKey, state]): Promise<string | null> => {
      // A marker or an outline: the write tools refuse it whatever the disk holds.
      if (state.isPartialView || state.refreshFailed) return null
      const path = expandPath(cacheKey)
      try {
        const mtime = await getFileModificationTimeAsync(path)
        if (mtime < startedAt || mtime <= state.timestamp) return null
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
        return path
      } catch (err) {
        // Deleted, or grown past the cap: the watcher evicts or marks it on its next pass.
        if (!isENOENT(err) && !(err instanceof FileTooLargeError)) logError(err)
        return null
      }
    }),
  )
  const changed = refreshed.filter((path): path is string => path !== null)
  if (changed.length === 0) return NONE
  changed.sort()
  // Relative only inside where the call ran: `../../x` names nothing clearly.
  const names = changed.map(path => relativeIfInside(path, cwd)).join(', ')
  const subject = changed.length === 1 ? '1 file you had read' : `${changed.length} files you had read`
  return { changed, note: `(${subject} changed under this call — your read now matches the disk: ${names})` }
}
