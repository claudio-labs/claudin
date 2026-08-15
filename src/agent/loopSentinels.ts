// Sentinel-based prompt expansion for /loop scheduled prompts.
//
// /loop schedules its next iterations either via CronCreate (fixed interval)
// or ScheduleWakeup (dynamic, self-paced). Inlining the full loop
// instructions into every scheduled prompt would re-send the long text on
// every tick, churning the prompt cache. Instead, autonomous/maintenance
// loops schedule a short sentinel and the delivery path (cronScheduler)
// expands it at fire time: full instructions on the first fire (and whenever
// loop.md changed since the last fire), a one-line reminder afterwards — so
// the long instruction text stays in the cached message prefix.

import { statSync } from 'fs'
import { join } from 'path'
import { getProjectRoot, onSessionSwitch } from 'src/platform/bootstrap/state.js'
import {
  SCHEDULE_WAKEUP_TOOL_NAME,
} from 'src/tools/ScheduleWakeupTool/prompt.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { isENOENT } from 'src/shared/errors.js'

/** Scheduled-prompt body for fixed-interval maintenance loops (CronCreate recurring). */
export const AUTONOMOUS_LOOP_SENTINEL = '<<autonomous-loop>>'
/** Scheduled-prompt body for dynamic maintenance loops (ScheduleWakeup). */
export const AUTONOMOUS_LOOP_DYNAMIC_SENTINEL = '<<autonomous-loop-dynamic>>'

/**
 * Built-in instructions for autonomous/maintenance loops (/loop with no
 * prompt). Referenced by the /loop skill for the immediate first run and
 * re-emitted here on the first sentinel fire of a session.
 */
export const MAINTENANCE_PROMPT = `Scheduled maintenance loop iteration.

If .claudin/loop.md exists, read it and follow it.
Otherwise, if ~/.claudin/loop.md exists, read it and follow it.
Otherwise:
- continue any unfinished work from the conversation
- tend to the current branch's pull request: review comments, failed CI runs, merge conflicts
- run cleanup passes such as bug hunts or simplification when nothing else is pending

Do not start new initiatives outside that scope.
Irreversible actions such as pushing or deleting only proceed when they continue something the transcript already authorized.`

const DYNAMIC_CONTINUATION = `This loop is self-paced (/loop dynamic mode): when this iteration's work is done, as the LAST action of the turn either call ${SCHEDULE_WAKEUP_TOOL_NAME} again — prompt set to exactly ${AUTONOMOUS_LOOP_DYNAMIC_SENTINEL}, with a delay chosen per the tool description and a one-sentence reason — to continue the loop, or omit the call to end it.`

type SentinelState = {
  /** A sentinel prompt with this exact body fired at least once this scope. */
  firedOnce: boolean
  /** loop.md fingerprint observed at the last fire (null = no loop.md). */
  loopMdFingerprint: string | null
}

/** Expansion-state scope for the main (lead) conversation. */
const LEAD_SCOPE = 'lead'

// Per-conversation, in-memory, keyed by `(scope, sentinel)` so teammate
// conversations don't contaminate the lead's first-fire tracking (a full
// expansion delivered to teammate A must not downgrade teammate B's first
// fire to a reminder). Dies with the process; reset on /clear so a fresh
// conversation always gets the full expansion on its first fire.
const sentinelState = new Map<string, SentinelState>()

function sentinelStateKey(sentinel: string, scope: string): string {
  return `${scope} ${sentinel}`
}

/**
 * Forget all first-fire / loop.md tracking. Called from /clear — the
 * conversation the full instructions lived in is gone, so the next fire
 * must re-deliver them — and from tests.
 */
export function resetLoopSentinelState(): void {
  sentinelState.clear()
}

// Every in-process conversation replacement (/clear via regenerateSessionId,
// /resume//branch via switchSession) emits sessionSwitched. The expansion
// state is conversation-scoped — a short reminder pointing at "instructions
// earlier in this conversation" is wrong in a transcript that never carried
// them — so reset it on every switch. Subscribed once at module load (same
// pattern as stableStubState), making it structurally impossible for /clear
// and /resume to drift apart. /clear also calls resetLoopSentinelState()
// directly (conversation.ts); the double-clear is harmless.
onSessionSwitch(resetLoopSentinelState)

export type LoopMdPaths = {
  projectLoopMdPath: string
  userLoopMdPath: string
}

function defaultLoopMdPaths(): LoopMdPaths {
  return {
    projectLoopMdPath: join(getProjectRoot(), '.claudin', 'loop.md'),
    userLoopMdPath: join(getClaudinConfigHomeDir(), 'loop.md'),
  }
}

/**
 * Fingerprint of the effective loop.md (project first, then user-level),
 * or null when neither exists. mtime+size detects "changed since last fire"
 * without hashing file contents on every tick. Blind spot: an edit that
 * keeps the byte size identical AND lands within the filesystem's mtime
 * granularity is not detected — worst case is one short reminder instead of
 * a full re-expansion, never a blocked fire.
 */
function loopMdFingerprint(paths: LoopMdPaths): string | null {
  for (const path of [paths.projectLoopMdPath, paths.userLoopMdPath]) {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- at most one stat per scheduled fire (fires are >= 60s apart), called from the scheduler's synchronous check()
      const st = statSync(path)
      return `${path}:${st.mtimeMs}:${st.size}`
    } catch (e) {
      // ENOENT is the normal "no loop.md here" case. Any other stat failure
      // (permissions, transient fs error) is logged but still treated as
      // absent — the worst case is an extra full expansion, never a blocked
      // fire.
      if (!isENOENT(e)) {
        logForDebugging(`[loopSentinels] failed to stat ${path}: ${e}`)
      }
    }
  }
  return null
}

export function isLoopSentinelPrompt(prompt: string): boolean {
  const trimmed = prompt.trim()
  return (
    trimmed === AUTONOMOUS_LOOP_SENTINEL ||
    trimmed === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
  )
}

/**
 * Expand a scheduled prompt at delivery time. Non-sentinel prompts pass
 * through unchanged. Sentinel-only prompts expand to the full maintenance
 * instructions on the first fire of the session — and again whenever the
 * effective loop.md changed (created, edited, or removed) since the last
 * fire — and to a short reminder on every other fire.
 *
 * `scope` keys the first-fire tracking per conversation: pass the firing
 * task's agentId for teammate-routed crons; omit for the lead conversation.
 * `pathsOverride` exists for tests; production callers omit it.
 */
export function expandLoopSentinelPrompt(
  prompt: string,
  pathsOverride?: LoopMdPaths,
  scope: string = LEAD_SCOPE,
): string {
  const sentinel = prompt.trim()
  if (
    sentinel !== AUTONOMOUS_LOOP_SENTINEL &&
    sentinel !== AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
  ) {
    return prompt
  }

  const fingerprint = loopMdFingerprint(pathsOverride ?? defaultLoopMdPaths())
  const stateKey = sentinelStateKey(sentinel, scope)
  const prior = sentinelState.get(stateKey)
  sentinelState.set(stateKey, {
    firedOnce: true,
    loopMdFingerprint: fingerprint,
  })

  const loopMdChanged =
    prior !== undefined && prior.loopMdFingerprint !== fingerprint
  if (prior === undefined || loopMdChanged) {
    return buildFullExpansion(sentinel, loopMdChanged)
  }
  return buildReminderExpansion(sentinel)
}

function buildFullExpansion(sentinel: string, loopMdChanged: boolean): string {
  const changedNote = loopMdChanged
    ? 'Note: the loop.md instructions changed since the last tick — re-read them and follow the updated version.\n\n'
    : ''
  const continuation =
    sentinel === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
      ? `\n\n${DYNAMIC_CONTINUATION}`
      : ''
  return `Scheduled loop tick.\n\n${changedNote}${MAINTENANCE_PROMPT}${continuation}`
}

function buildReminderExpansion(sentinel: string): string {
  const base =
    'Scheduled loop tick — continue the loop per the instructions earlier in this conversation. If they are no longer in context, re-read .claudin/loop.md (or ~/.claudin/loop.md).'
  if (sentinel !== AUTONOMOUS_LOOP_DYNAMIC_SENTINEL) return base
  return `${base} Then, as the LAST action of the turn, call ${SCHEDULE_WAKEUP_TOOL_NAME} again (prompt: ${AUTONOMOUS_LOOP_DYNAMIC_SENTINEL}) to continue the loop, or omit it to end the loop.`
}
