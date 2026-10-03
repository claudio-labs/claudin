import { useEffect, useState } from 'react'
import { getLastInteractionTime } from 'src/platform/bootstrap/state.js'
import { logError } from 'src/shared/log.js'
import { fetchPrStatus, type PrLabel, type PrReviewState } from 'src/vcs/git/ghPrStatus.js'
import { emptyPill, pillAfterAnswer } from 'src/vcs/hooks/prStatus/pillState.js'
import { type PollRules, PrStatusPoller, SYSTEM_CLOCKS } from 'src/vcs/hooks/prStatus/prStatusPoller.js'

const POLL_INTERVAL_MS = 2_000
const IDLE_STOP_MS = 60 * 60_000

/** A CLI that needs this long per answer would make the footer drag; stop asking it. */
const PILL_POLL_RULES: PollRules = {
  intervalMs: POLL_INTERVAL_MS,
  slowAnswerMs: 4 * 1000,
  idleStopMs: IDLE_STOP_MS,
}

export type PrStatusState = {
  number: number | null
  url: string | null
  reviewState: PrReviewState | null
  label: PrLabel | null
  lastUpdated: number
}

export function usePrStatus(isLoading: boolean, enabled = true): PrStatusState {
  const [pill, setPill] = useState<PrStatusState>(() => emptyPill())
  const [poller] = useState(
    () =>
      new PrStatusPoller(PILL_POLL_RULES, {
        ask: fetchPrStatus,
        onAnswer: answer => {
          const now = Date.now()
          setPill(current => pillAfterAnswer(current, answer, now))
        },
        onError: logError,
        ...SYSTEM_CLOCKS,
        lastInteractionAt: getLastInteractionTime,
        schedule: (task, delayMs) => {
          const timer = setTimeout(task, delayMs)
          return () => clearTimeout(timer)
        },
      }),
  )

  useEffect(() => {
    if (!enabled) return
    poller.resume()
    return () => poller.pause()
  }, [poller, isLoading, enabled])

  return pill
}
