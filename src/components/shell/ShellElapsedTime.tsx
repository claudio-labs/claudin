import * as React from 'react'

import { useAnchoredElapsedSeconds } from '../../hooks/useElapsedTime.js'
import { Text } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'

/**
 * How long a shell has to run before its elapsed time is worth showing. Below
 * this most commands have already finished, so a counter would just flicker.
 */
export const SHELL_PROGRESS_MIN_SECONDS = 2

type Props = {
  /**
   * Elapsed seconds as last reported by the shell's output poller, when there
   * is one. Only used to anchor the clock — the display ticks on its own.
   */
  elapsedTimeSeconds?: number
  timeoutMs?: number
}

/**
 * Live `(12s)` / `(12s · timeout 2m)` stopwatch for a running shell command.
 *
 * The static {@link ShellTimeDisplay} it replaces on the in-progress paths can
 * only show what the last progress message carried, so the clock stood still
 * for the first ~2s (PROGRESS_THRESHOLD_MS, before any progress is emitted)
 * and froze again whenever the poller went quiet. This one keeps its own 1s
 * interval, so a long build/curl always shows time moving.
 *
 * The reported value still wins when it is ahead of the local clock: the row
 * remounts when the "Running…" branch swaps for the one with output, and the
 * fresh mount would otherwise restart the count at zero.
 */
export function ShellElapsedTime({
  elapsedTimeSeconds,
  timeoutMs,
}: Props): React.ReactNode {
  const elapsedSeconds = useAnchoredElapsedSeconds(elapsedTimeSeconds)

  const timeout = timeoutMs
    ? formatDuration(timeoutMs, { hideTrailingZeros: true })
    : undefined

  // Under a second there is nothing worth reading yet, and most commands
  // never get here — showing "(0s)" would just flicker on every fast one.
  if (elapsedSeconds < 1) {
    return timeout ? <Text dimColor>{`(timeout ${timeout})`}</Text> : null
  }

  const elapsed = formatDuration(elapsedSeconds * 1000)
  return (
    <Text dimColor>
      {timeout ? `(${elapsed} · timeout ${timeout})` : `(${elapsed})`}
    </Text>
  )
}

/**
 * Live ` · 1m 9s` counter for the collapsed group header, e.g.
 * `Running 4 shell commands · 1m 9s…`.
 *
 * The header is the line people watch while a batch of shells runs, and it
 * carried no time at all — a `npm install` fanned out over four calls looked
 * frozen until the whole group resolved. Like {@link ShellElapsedTime} this
 * ticks on its own, so it survives a quiet poller; it renders nothing until
 * {@link SHELL_PROGRESS_MIN_SECONDS} so short batches stay clean.
 */
export function ShellGroupElapsedTime({
  elapsedTimeSeconds,
}: {
  elapsedTimeSeconds?: number
}): React.ReactNode {
  const elapsedSeconds = useAnchoredElapsedSeconds(elapsedTimeSeconds)

  if (elapsedSeconds < SHELL_PROGRESS_MIN_SECONDS) {
    return null
  }

  return (
    <>
      {' · '}
      <Text bold>{formatDuration(elapsedSeconds * 1000)}</Text>
    </>
  )
}
