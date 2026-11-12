/**
 * gitStatus delta — inject on turn 1, and again when the session moves.
 *
 * WHY: `getGitStatus` in `src/agent/context.ts` explicitly documents its
 * output as "a snapshot in time, and will not update during the
 * conversation." Today that snapshot is re-appended to every system
 * prompt via `appendSystemContext` (src/providers/transport/api.ts:486), costing
 * bytes on every request for content that cannot change.
 *
 * Since the snapshot is immutable by design, the scanner's job is
 * simpler than the other deltas: if any prior `git_status_delta`
 * attachment exists in the transcript, do nothing; otherwise emit the
 * full snapshot once.
 *
 * One exception: `/cd` re-roots the session in another directory
 * (sessions/rerootSession.ts), and the snapshot announced for the old one
 * names the wrong branch and the wrong commits. An announcement records the
 * directory it was taken in, and a snapshot for another directory is
 * announced again. A transcript from before the field existed has none, and
 * is never re-announced.
 *
 * Mirrors the pattern of:
 *   - `src/mcp/mcpInstructionsDelta.ts`
 *   - `src/agent/tools/toolSearch.ts` (`getDeferredToolsDelta`)
 *   - `src/agent/attachments/attachments.ts` (`getAgentListingDeltaAttachment`)
 *
 * Complementary to the other two Phase-2 deltas (`claudeMdDelta`,
 * `todoReminderDelta`): together they cover the static context that was
 * previously re-serialized every turn.
 */


/**
 * Key inside the system-context object (see `getSystemContext` in
 * src/agent/context.ts) that this delta replaces when dedup is active.
 * `api.ts::filterStaticDedupKeys` reads this to know which key to strip
 * from `appendSystemContext`, avoiding double-announce.
 */
export const GIT_STATUS_CONTEXT_KEY = 'gitStatus' as const

export type GitStatusDelta = {
  /** Full status snapshot — emitted once per directory the session roots in. */
  content: string
  /** The session root the snapshot was taken in, when the caller names it. */
  cwd?: string
}

type ScannableMessage = {
  type: string
  attachment?: { type: string; cwd?: string }
}

/**
 * Emit the gitStatus attachment only when no prior `git_status_delta`
 * exists in the transcript, or when the last one was taken in a directory
 * other than `cwd`. Returns `null` on any other turn.
 *
 * Pure function: all state is passed in. The caller owns fetching the
 * current gitStatus string (via `getGitStatus` or the cached
 * `systemContext.gitStatus`). Passing `null`/empty is a no-op.
 */
export function getGitStatusDelta(
  currentGitStatus: string | null | undefined,
  messages: readonly ScannableMessage[],
  cwd?: string,
): GitStatusDelta | null {
  if (!currentGitStatus) return null

  let last: { cwd?: string } | null = null
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment?.type === 'git_status_delta') last = msg.attachment
  }

  // Already announced — subsequent turns are a no-op. The snapshot is
  // immutable by design (see getGitStatus in src/agent/context.ts), for the
  // directory it was taken in.
  if (last && (cwd === undefined || last.cwd === undefined || last.cwd === cwd)) {
    return null
  }

  return cwd === undefined
    ? { content: currentGitStatus }
    : { content: currentGitStatus, cwd }
}
