/**
 * The active session id and the switch funnel.
 *
 * `sessionId` and `sessionProjectDir` are only ever written together, through
 * switchSession/regenerateSessionId, so they cannot drift apart. Both routes
 * funnel through emitSessionSwitched, which is where conversation-scoped state
 * gets dropped — see the comment on it.
 */
import { randomUUID } from 'src/shared/data/crypto.js'
import { clearBetaHeaderLatches } from 'src/platform/bootstrap/state/latches.js'
import { STATE } from 'src/platform/bootstrap/state/store.js'
import { createSignal } from 'src/shared/signal.js'
import type { SessionId } from 'src/shared/types/ids.js'

export function getSessionId(): SessionId {
  return STATE.sessionId
}

export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  // Drop the outgoing session's plan-slug entry so the Map doesn't
  // accumulate stale keys. Callers that need to carry the slug across
  // (REPL.tsx clearContext) read it before calling clearConversation.
  STATE.planSlugCache.delete(STATE.sessionId)
  // Regenerated sessions live in the current project: reset projectDir to
  // null so getTranscriptPath() derives from originalCwd.
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  // Emit on the same signal switchSession uses — listeners (concurrentSessions
  // PID file, stableStubState per-session map) treat both transitions
  // uniformly. Without this, /clear and /resume drift apart.
  emitSessionSwitched(STATE.sessionId)
  return STATE.sessionId
}

export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

/**
 * Atomically switch the active session. `sessionId` and `sessionProjectDir`
 * always change together — there is no separate setter for either, so they
 * cannot drift out of sync (CC-34).
 *
 * @param projectDir — directory containing `<sessionId>.jsonl`. Omit (or
 *   pass `null`) for sessions in the current project — the path will derive
 *   from originalCwd at read time. Pass `dirname(transcriptPath)` when the
 *   session lives in a different project directory (git worktrees,
 *   cross-project resume). Every call resets the project dir; it never
 *   carries over from the previous session.
 */
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  // Drop the outgoing session's plan-slug entry so the Map stays bounded
  // across repeated /resume. Only the current session's slug is ever read
  // (plans.ts getPlanSlug defaults to getSessionId()).
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  emitSessionSwitched(sessionId)
}

const sessionSwitched = createSignal<[id: SessionId]>()

/**
 * Single funnel for the sessionSwitched signal — every conversation-
 * replacement path (/clear via regenerateSessionId; /resume, /branch,
 * --resume hydration, etc. via switchSession) goes through here.
 *
 * Conversation-scoped state owned by this module is dropped at the funnel,
 * not at the call sites, so the paths cannot drift apart: a pending /loop
 * wakeup's prompt continues "this conversation's" loop, and after the
 * switch that conversation no longer exists — letting it fire would inject
 * an autonomous-loop prompt into a transcript that never armed one.
 * Conversation-scoped state owned by other modules (loopSentinels'
 * first-fire memory, stableStubState's clipped-id map) subscribes via
 * onSessionSwitch for the same reason.
 */
function emitSessionSwitched(id: SessionId): void {
  STATE.pendingSessionWakeup = null
  // Beta-header latches are conversation-scoped: carrying e.g. the
  // deferred-delta legacy latch from one session into a /resume'd
  // delta-format session would inject the legacy prepend at messages[0]
  // of a history whose warm cache never contained it. The new
  // conversation's cache prefix is distinct anyway, so re-evaluation is
  // free. (/clear also clears these directly; double-clear is idempotent.)
  clearBetaHeaderLatches()
  // Advance the epoch: everything in the incoming session's history was
  // written before this moment — the in-process equivalent of "before
  // process start" for the legacy-latch warm-cache scan.
  STATE.sessionEpochMs = Date.now()
  sessionSwitched.emit(id)
}

/**
 * Register a callback that fires when switchSession changes the active
 * sessionId. bootstrap can't import listeners directly (DAG leaf), so
 * callers register themselves. concurrentSessions.ts uses this to keep the
 * PID file's sessionId in sync with --resume.
 */
export const onSessionSwitch = sessionSwitched.subscribe

/**
 * Project directory the current session's transcript lives in, or `null` if
 * the session was created in the current project (common case — derive from
 * originalCwd). See `switchSession()`.
 */
export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}
