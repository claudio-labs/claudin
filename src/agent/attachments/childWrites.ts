/**
 * The files this session's children wrote, and the mtime each write left.
 *
 * ## Why it exists
 *
 * A child — a sub-agent, the extract_memories and auto_dream forks — runs on
 * its own copy of the read state (`createSubagentContext`), so
 * `settleOwnWrites` brings the CHILD's entries up to date and the parent's
 * stay as they were. The parent's changed-files watcher (`changedFile.ts`)
 * then took every file a child wrote for an outside edit: "modified, either by
 * the user or by a linter", with a snippet of the change. In the
 * 2026-11-14..16 census that was 59 notes and 248K chars, none of them from
 * the user, and they arrived while the agents were still running.
 *
 * A child's write is the session's own. So the child's settle records it here
 * (`ownWrites.ts`), and the watcher of the thread that owns the session
 * (`ownsSessionScopedState`) brings its entry up to date and reports the
 * names in one `child_written_files` note: no diff, as for the model's own
 * calls.
 *
 * ## Why path → mtime
 *
 * A path alone would claim every later change to the file. With the mtime the
 * write left, the claim is for that version only: an edit the user makes
 * afterwards leaves another mtime and gets its diff as before.
 *
 * Process-wide rather than per context, because the child and the thread that
 * reads the record never share one. Cleared when the session is replaced
 * (/clear, /resume), and capped: past `MAX_CHILD_WRITES` the oldest goes, and
 * its file is reported with a diff again.
 *
 * Known limit: only a file in the child's read state is recorded. One the
 * child changed through Bash without ever reading it has no entry there, so
 * the parent still gets the diff note for it.
 */
import { onSessionSwitch } from 'src/platform/bootstrap/state.js'

export const MAX_CHILD_WRITES = 512

/** Absolute path → the mtime the child's write left. Oldest record first. */
const childWrites = new Map<string, number>()

export function recordChildWrite(path: string, mtime: number): void {
  // Re-inserted, so a file written again counts as the newest.
  childWrites.delete(path)
  childWrites.set(path, mtime)
  if (childWrites.size <= MAX_CHILD_WRITES) return
  const oldest = childWrites.keys().next()
  if (!oldest.done) childWrites.delete(oldest.value)
}

/** The mtime a child's last recorded write left on `path`, if any. */
export function childWriteMtime(path: string): number | undefined {
  return childWrites.get(path)
}

/** Forgets every record: on a session switch, and from tests. */
export function resetChildWrites(): void {
  childWrites.clear()
}

// The record describes the conversation that spawned the children. Subscribed
// once at module load, as loopSentinels does.
onSessionSwitch(resetChildWrites)
