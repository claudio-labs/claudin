import { useEffect } from 'react'
import { useCommandQueue } from 'src/agent/hooks/useCommandQueue.js'
import {
  updateSessionStatus,
  whenSessionRegistered,
} from 'src/sessions/concurrentSessions.js'
import { activityOf, reportSessionActivity } from 'src/sessions/peers/activity.js'

/**
 * Report whether this session is busy — a turn running, or a command queued
 * for the main thread that will start one — or idle, both to the idle
 * subscriptions and to the PID record ListAgents reads.
 */
export function useSessionActivity(isLoading: boolean, enabled: boolean): void {
  const queuedForMain = useCommandQueue().filter(cmd => cmd.agentId === undefined).length
  const activity = activityOf({ isLoading, queuedForMain })
  useEffect(() => {
    if (!enabled) return
    reportSessionActivity(activity)
    // Queued behind registration, in order, so the record ends on the last state.
    void whenSessionRegistered().then(registered =>
      registered ? updateSessionStatus(activity) : undefined,
    )
  }, [activity, enabled])
}
