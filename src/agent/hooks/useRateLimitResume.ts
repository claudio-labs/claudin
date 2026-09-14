import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  canArmResume,
  describeLimit,
  IDLE_RECHECK_MS,
  isSessionIdle,
  MAX_AUTO_RESUMES,
  RESUME_COMMAND,
  RESUME_GRACE_MS,
  RESUME_MARKER,
  resumeDelayMs,
} from 'src/agent/hooks/rateLimitResume.js'
import {
  enqueuePendingNotification,
  getCommandQueueLength,
} from 'src/agent/messageQueueManager.js'
import { createSystemMessage } from 'src/agent/messages/messages.js'
import {
  getIsNonInteractiveSession,
  getIsRemoteMode,
} from 'src/platform/bootstrap/state.js'
import { clearProviderRateLimit } from 'src/providers/rateLimitState.js'
import { useProviderRateLimit } from 'src/providers/rateLimitStateHook.js'
import type { Message } from 'src/shared/types/message.js'
import { useNotifications } from 'src/terminal/contexts/notifications.js'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'

/**
 * Two keys, not one. `addNotification` drops a notification whose key is
 * already current or queued, so re-using one key meant the "resuming" notice
 * was silently discarded whenever the "rate limited" toast was still up — and
 * that toast lasts 8s against a 5s cancel window, so it usually was.
 */
const LIMIT_NOTIFICATION_KEY = 'provider-rate-limit'
const RESUME_NOTIFICATION_KEY = 'provider-rate-limit-resume'

export type RateLimitResumeDeps = {
  /** True while a query is in flight (the REPL's `isLoading`). */
  isLoading: boolean
  /** The prompt input's live draft, so a half-typed message blocks the resume. */
  inputValueRef: RefObject<string>
  setMessages: Dispatch<SetStateAction<Message[]>>
}

/**
 * Picks the interrupted work back up when the provider's limit clears.
 *
 * The turn ends as soon as the limit is hit — nothing blocks inside the retry
 * loop — so the prompt comes straight back and the user is free to switch
 * provider, compact, or walk away. If they are still here and idle when the
 * reset arrives, this re-sends the work rather than making them remember to.
 *
 * Mounted once from the REPL, next to `useScheduledTasks`, whose fire path this
 * follows: a visible marker via `setMessages`, and the prompt itself enqueued
 * hidden at 'later' priority so it drains between turns.
 */
export function useRateLimitResume({
  isLoading,
  inputValueRef,
  setMessages,
}: RateLimitResumeDeps): void {
  const limit = useProviderRateLimit()
  const { addNotification } = useNotifications()
  const [isResumePending, setIsResumePending] = useState(false)

  // Latest-value refs: the timers below are armed once per limit and must not
  // read a busy/draft state captured when they were scheduled.
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading
  const cancelledRef = useRef(false)
  const announcedRef = useRef<number | null>(null)
  // Deliberately NOT reset when a new limit arrives: the loop worth stopping is
  // resume → 429 → wait → resume, and each turn of it records a new limit.
  const resumeCountRef = useRef(0)

  const isIdle = useCallback(
    () =>
      isSessionIdle({
        isLoading: isLoadingRef.current,
        draft: inputValueRef.current ?? '',
        queueLength: getCommandQueueLength(),
      }),
    [inputValueRef],
  )

  // Announce a newly recorded limit once. Keyed on observedAtMs so a second
  // limit later in the session announces again, and a re-render does not.
  useEffect(() => {
    if (getIsNonInteractiveSession() || getIsRemoteMode()) return
    if (limit === null) {
      announcedRef.current = null
      cancelledRef.current = false
      setIsResumePending(false)
      return
    }
    if (announcedRef.current === limit.observedAtMs) return
    announcedRef.current = limit.observedAtMs
    cancelledRef.current = false
    // A limit recorded while a resume was already pending supersedes it —
    // otherwise the armed timer fires, clears the record that just arrived and
    // sends the request straight into a live limit.
    setIsResumePending(false)
    addNotification({
      key: LIMIT_NOTIFICATION_KEY,
      text: describeLimit(limit, Date.now()),
      priority: 'high',
    })
  }, [limit, addNotification])

  // Wait out the reset, then wait for a quiet moment.
  useEffect(() => {
    if (getIsNonInteractiveSession() || getIsRemoteMode()) return
    if (cancelledRef.current) return
    if (resumeCountRef.current >= MAX_AUTO_RESUMES) return
    const resetsAtMs = limit?.resetsAtMs
    if (!canArmResume(resetsAtMs, Date.now())) return

    let timer: ReturnType<typeof setTimeout>
    const check = () => {
      if (cancelledRef.current) return
      if (!isIdle()) {
        timer = setTimeout(check, IDLE_RECHECK_MS)
        return
      }
      setIsResumePending(true)
    }
    timer = setTimeout(check, resumeDelayMs(resetsAtMs, Date.now()))
    return () => clearTimeout(timer)
  }, [limit, isIdle])

  // The cancellable window, then the resume itself.
  useEffect(() => {
    if (!isResumePending) return
    addNotification({
      key: RESUME_NOTIFICATION_KEY,
      text: 'Limit reset · resuming… (esc to cancel)',
      // Immediate so it displaces the "rate limited" toast instead of queueing
      // behind it — a notice the user cannot see is not a cancel window.
      priority: 'immediate',
      timeoutMs: RESUME_GRACE_MS,
    })
    const timer = setTimeout(() => {
      setIsResumePending(false)
      if (cancelledRef.current || !isIdle()) return
      resumeCountRef.current += 1
      // Drop the record first: the request about to go out is what proves the
      // limit lifted, and leaving it set would re-arm the timer.
      clearProviderRateLimit()
      setMessages(previous => [
        ...previous,
        createSystemMessage(RESUME_MARKER, 'info'),
      ])
      enqueuePendingNotification({ ...RESUME_COMMAND })
    }, RESUME_GRACE_MS)
    return () => clearTimeout(timer)
  }, [isResumePending, addNotification, setMessages, isIdle])

  const cancelResume = useCallback(() => {
    cancelledRef.current = true
    setIsResumePending(false)
  }, [])

  // Esc is free here: CancelRequestHandler only claims it when something is
  // running or the queue is non-empty, and neither is true while this window
  // is open — that is the precondition for opening it.
  useKeybinding('chat:cancel', cancelResume, {
    context: 'Chat',
    isActive: isResumePending,
  })
}
