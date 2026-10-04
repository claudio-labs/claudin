/**
 * The startup auto-mode gate check, run against the app state: once per
 * process, and again whenever the session's model changes.
 */
import { useEffect, useRef } from 'react'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from 'src/terminal/state/AppState.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { logError } from 'src/shared/log.js'
import {
  type AutoModeGateCheckResult,
  verifyAutoModeGateAccess,
} from 'src/permissions/permissionSetup.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'

const GATE_NOTICE_KEY = 'auto-mode-gate-notification'

const gateCheck = { started: false }

/** Applies the verdict to the state's current context, not to the checked snapshot. */
function withGateVerdict(prev: AppState, verdict: AutoModeGateCheckResult): AppState {
  const toolPermissionContext = verdict.updateContext(prev.toolPermissionContext)
  const text = verdict.notification
  if (toolPermissionContext === prev.toolPermissionContext && text === undefined) return prev
  const queue =
    text === undefined
      ? prev.notifications.queue
      : [
          ...prev.notifications.queue,
          { key: GATE_NOTICE_KEY, text, color: 'warning' as const, priority: 'high' as const },
        ]
  return { ...prev, toolPermissionContext, notifications: { ...prev.notifications, queue } }
}

export async function checkAndDisableAutoModeIfNeeded(
  toolPermissionContext: ToolPermissionContext,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<void> {
  if (autoModeStateModule === null || gateCheck.started) return
  gateCheck.started = true
  const verdict = await verifyAutoModeGateAccess(toolPermissionContext)
  setAppState(prev => withGateVerdict(prev, verdict))
}

/** Lets the next check run again (after `/login`, or a model change). */
export function resetAutoModeGateCheck(): void {
  gateCheck.started = false
}

export function useKickOffCheckAndDisableAutoModeIfNeeded(): void {
  const mainLoopModel = useAppState(state => state.mainLoopModel)
  const sessionModel = useAppState(state => state.mainLoopModelForSession)
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const mounted = useRef(false)

  useEffect(() => {
    // The mount runs the check as is; a later model change re-arms it first.
    if (mounted.current) resetAutoModeGateCheck()
    mounted.current = true
    checkAndDisableAutoModeIfNeeded(store.getState().toolPermissionContext, setAppState).catch(
      (error: unknown) => logError(error),
    )
  }, [mainLoopModel, sessionModel, store, setAppState])
}
