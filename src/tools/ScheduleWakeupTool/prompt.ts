export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'

/** Runtime clamp bounds for delaySeconds. Clamped, never rejected. */
export const WAKEUP_MIN_DELAY_SECONDS = 60
export const WAKEUP_MAX_DELAY_SECONDS = 3600

/**
 * Clamp a model-chosen delay into [60, 3600] seconds. Out-of-range values
 * are clamped rather than rejected so a bad pick never breaks the loop.
 * NaN (nothing sensible to clamp) falls back to the minimum so the loop
 * resumes quickly instead of sleeping an hour on garbage input.
 */
export function clampWakeupDelaySeconds(delaySeconds: number): number {
  if (Number.isNaN(delaySeconds)) return WAKEUP_MIN_DELAY_SECONDS
  return Math.min(
    WAKEUP_MAX_DELAY_SECONDS,
    Math.max(WAKEUP_MIN_DELAY_SECONDS, Math.round(delaySeconds)),
  )
}

export const SCHEDULE_WAKEUP_DESCRIPTION =
  'Schedule a one-shot in-session wakeup that resumes /loop dynamic mode after a self-chosen delay. Only one wakeup can be pending at a time; omit the call to end the loop.'

export const SCHEDULE_WAKEUP_PROMPT = `Schedule when to resume work in /loop dynamic mode — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task.

Do NOT schedule a short-interval wakeup to poll for background work you started — when harness-tracked work finishes, you are re-invoked automatically. Instead schedule a long fallback (1200s+) so the loop survives if the work hangs. The exception is external work the harness cannot track (a CI run, a deploy, a remote queue) — there, pick a delay matched to how fast that state actually changes.

Pass the /loop prompt back via \`prompt\` each turn so the next firing repeats the task. Omit the call to end the loop.

## Picking delaySeconds

The Anthropic prompt cache has a 5-minute TTL. Sleeping past 300 seconds means the next wake-up reads your full conversation context uncached — slower and more expensive.

- Under 5 minutes (60s–270s): cache stays warm. Right for actively polling external state the harness can't notify you about.
- 5 minutes to 1 hour (300s–3600s): pay the cache miss. Right when there's no point checking sooner, or as a long fallback heartbeat.

Don't pick 300s — it's the worst of both. If tempted to "wait 5 minutes", either drop to 270s (stay in cache) or commit to 1200s+. For idle ticks with no specific signal, default to 1200s–1800s.

The runtime clamps to [${WAKEUP_MIN_DELAY_SECONDS}, ${WAKEUP_MAX_DELAY_SECONDS}].

## The reason field

One short sentence on what you chose and why — shown to the user. "watching CI run" beats "waiting."

## Runtime behavior

The wakeup is session-only (nothing written to disk, gone when Claude exits) and fires once, while the REPL is idle, by enqueuing \`prompt\` as if the user had submitted it. Only one wakeup can be pending — calling ${SCHEDULE_WAKEUP_TOOL_NAME} again before it fires replaces it. In non-interactive (-p) runs the process exits after the final turn and any pending wakeup is discarded.

## Cancelling

If the user asks to stop the loop while a wakeup is already armed, call ${SCHEDULE_WAKEUP_TOOL_NAME} with \`cancel: true\` (other fields ignored) to kill it immediately. /clear also discards any pending wakeup.`
