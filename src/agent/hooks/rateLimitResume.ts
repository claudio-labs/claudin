/**
 * The decisions behind `useRateLimitResume`, kept free of React and of the
 * notification/queue plumbing so they can be tested without mocks.
 */

import type { ProviderRateLimit } from 'src/providers/rateLimitState.js'
import { formatCountdownDuration } from 'src/shared/text/format.js'
import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'

/**
 * How long the "resuming" notice stays up before the prompt is enqueued. The
 * window exists so a user who is at the keyboard can stop it.
 */
export const RESUME_GRACE_MS = 5_000

/**
 * How often to re-check once the reset has passed but the session is busy or
 * the user is mid-sentence. Only runs after the reset, never during the wait.
 */
export const IDLE_RECHECK_MS = 5_000

/**
 * The furthest-out reset this will wait for. A weekly window is days away —
 * nobody leaves a session open that long, `setTimeout` fires IMMEDIATELY for a
 * delay above 2^31-1 ms, and the countdown in the transcript already tells the
 * user when to come back. Beyond this the limit is shown but not resumed.
 */
export const RESUME_MAX_HORIZON_MS = 6 * 60 * 60 * 1000

/**
 * How many times one session will resume itself. Without a ceiling, a resume
 * that hits the limit again re-arms the whole cycle, and an unattended session
 * loops resume → 429 → wait → resume for as long as it is left open.
 */
export const MAX_AUTO_RESUMES = 3

/**
 * What the timer sends. Not a replay of the user's original prompt: the whole
 * interrupted turn — the request, whatever the assistant produced, the tool
 * results and the limit message — is already in history, so a continuation is
 * what resumes it, and nothing has to be captured and carried across the wait.
 *
 * `isMeta` keeps it out of the transcript (the visible marker is a system
 * message instead), and 'later' keeps it behind anything the user types.
 */
export const RESUME_COMMAND = {
  value: 'Continue where you left off.',
  mode: 'prompt',
  priority: 'later',
  isMeta: true,
} as const satisfies QueuedCommand

export const RESUME_MARKER = 'Rate limit cleared — resuming'

/**
 * Whether a recorded limit is one this can wait out: it has to report a reset,
 * and that reset has to be inside the horizon.
 */
export function canArmResume(
  resetsAtMs: number | undefined,
  nowMs: number,
): resetsAtMs is number {
  if (resetsAtMs === undefined) return false
  return resetsAtMs - nowMs <= RESUME_MAX_HORIZON_MS
}

/** How long to sleep before checking, never negative and never overflowing. */
export function resumeDelayMs(resetsAtMs: number, nowMs: number): number {
  return Math.min(Math.max(0, resetsAtMs - nowMs), RESUME_MAX_HORIZON_MS)
}

/** Toast text for a limit that was just recorded. */
export function describeLimit(limit: ProviderRateLimit, nowMs: number): string {
  const head = `Rate limited · ${limit.providerLabel}`
  if (limit.resetsAtMs === undefined) return head
  const remainingMs = limit.resetsAtMs - nowMs
  if (remainingMs <= 0) return head
  return `${head} · back in ${formatCountdownDuration(remainingMs)}`
}

export type SessionActivity = {
  /** True while a query is in flight. */
  isLoading: boolean
  /** The prompt input's current draft. */
  draft: string
  /** How many commands are already waiting to run. */
  queueLength: number
}

/**
 * Whether the session is quiet enough to re-send the interrupted work.
 *
 * All three conditions matter for the same reason: the resume must never
 * displace something the user is doing. A draft in the input means they are
 * mid-thought; a non-empty queue means they already said what comes next.
 */
export function isSessionIdle({
  isLoading,
  draft,
  queueLength,
}: SessionActivity): boolean {
  return !isLoading && draft === '' && queueLength === 0
}
