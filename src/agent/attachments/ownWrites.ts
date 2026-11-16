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
 * ## A child's writes
 *
 * A child (a sub-agent, a memory fork) settles into its own copy of the read
 * state, so the above brings the child up to date and leaves its parent
 * behind. When the caller is a child (`childOf`), the settle also records
 * what the child's read state now holds as written under the call — a Write,
 * Edit or Patch of its own, or a change the lines above just adopted — in
 * `childWrites.ts`. The watcher of the thread that owns the session then
 * adopts those versions and names them in one `child_written_files` note,
 * where it used to report each as the user's with a diff. So the changes a
 * background agent makes do stay the watcher's, but as names.
 *
 * On by default since 2026-10-21: in the branch-point replay (team memory
 * `edit-method-census-2026-10-21`) the model's next action was the same with
 * the line as with the notes, and the context ~2% of a session smaller.
 * `CLAUDIN_OWN_WRITES=0` brings the watcher's notes back. Read per call, so a
 * test can set it.
 */
import {
  adoptWrittenEntry,
  changedFileCandidates,
} from 'src/agent/attachments/changedFile.js'
import { recordChildWrite } from 'src/agent/attachments/childWrites.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { isENOENT } from 'src/shared/errors.js'
import { getFileModificationTimeAsync } from 'src/shared/fs/file.js'
import type { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { expandPath, relativeIfInside } from 'src/shared/fs/path.js'
import { FileTooLargeError } from 'src/shared/fs/readFileInRange.js'
import { logError } from 'src/shared/log.js'
import type { Tool } from 'src/tools/Tool.js'

/**
 * How far before the call's start a write of the call may be dated. A file's
 * mtime comes from the kernel's coarse clock, up to a tick behind the
 * `Date.now()` the tool loop took first — seen 1 ms early on a HZ=1000
 * kernel, and a tick is 4 ms at HZ=250, 10 ms at HZ=100. Without it a child's
 * quick Write goes unrecorded and its parent gets the diff note.
 */
const MTIME_CLOCK_SLACK_MS = 10

function isOwnWritesEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_OWN_WRITES)
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

/**
 * The tool loop's entry: claims for this call what changed while it ran; see
 * the module comment. `childOf` says the caller is a child of the session,
 * whose writes its parent is told of by name.
 */
export async function settleOwnWrites(
  tool: FileChangingTool,
  input: unknown,
  readFileState: FileStateCache,
  startedAt: number,
  cwd: string,
  childOf = false,
): Promise<OwnWrites> {
  if (!isOwnWritesEnabled() || !mayChangeFiles(tool, input)) return NONE
  let own = NONE
  try {
    own = await refreshOwnWrites(readFileState, startedAt, cwd)
  } catch (err) {
    // Fail open: the watcher reports the change, as it did before.
    logError(err)
  }
  if (childOf) await recordChildWrites(readFileState, startedAt)
  return own
}

/**
 * Records every entry the call left dated to the disk: one a write tool set
 * to its own write, or one `refreshOwnWrites` just adopted. An entry older
 * than the call, or one the disk has moved past, is not this call's.
 */
async function recordChildWrites(readFileState: FileStateCache, startedAt: number): Promise<void> {
  const since = startedAt - MTIME_CLOCK_SLACK_MS
  await Promise.all(
    changedFileCandidates(readFileState).map(async ([cacheKey, state]) => {
      if (state.isPartialView || state.refreshFailed || state.timestamp < since) return
      const path = expandPath(cacheKey)
      try {
        const mtime = await getFileModificationTimeAsync(path)
        if (mtime === state.timestamp) recordChildWrite(path, mtime)
      } catch (err) {
        // Fail open: unrecorded, the parent's watcher reports it with a diff, as before.
        if (!isENOENT(err)) logError(err)
      }
    }),
  )
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
        await adoptWrittenEntry(cacheKey, path, state, mtime, readFileState)
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
