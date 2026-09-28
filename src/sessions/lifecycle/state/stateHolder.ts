/**
 * The session's state (idle, running, or blocked on the user) and the three
 * listeners that hear about it: the state, the external metadata, and the
 * permission mode. Each listener is a single slot: setting one replaces the
 * previous one, and null detaches it.
 */
import { enqueueSdkEvent } from 'src/agent/sdkEventQueue.js'
import { mirrorTransition } from 'src/sessions/lifecycle/state/metadataMirror.js'
import type {
  RequiresActionDetails,
  SessionExternalMetadata,
  SessionState,
} from 'src/sessions/lifecycle/state/types.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import type { PermissionMode } from 'src/shared/types/permissions.js'

type StateListener = (state: SessionState, details?: RequiresActionDetails) => void
type MetadataListener = (metadata: SessionExternalMetadata) => void
type PermissionModeListener = (mode: PermissionMode) => void

let currentState: SessionState = 'idle'
let actionPending = false
let stateListener: StateListener | null = null
let metadataListener: MetadataListener | null = null
let permissionModeListener: PermissionModeListener | null = null

export function getSessionState(): SessionState {
  return currentState
}

export function notifySessionStateChanged(
  state: SessionState,
  details?: RequiresActionDetails,
): void {
  currentState = state
  stateListener?.(state, details)
  const mirrored = mirrorTransition(actionPending, state, details)
  actionPending = mirrored.actionPending
  for (const update of mirrored.updates) metadataListener?.(update)
  // Read at every transition: an SDK host opts in through its environment.
  if (isEnvTruthy(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)) {
    enqueueSdkEvent({ type: 'system', subtype: 'session_state_changed', state })
  }
}

export function notifySessionMetadataChanged(metadata: SessionExternalMetadata): void {
  metadataListener?.(metadata)
}

export function notifyPermissionModeChanged(mode: PermissionMode): void {
  permissionModeListener?.(mode)
}

export function setSessionStateChangedListener(listener: StateListener | null): void {
  stateListener = listener
}

export function setSessionMetadataChangedListener(listener: MetadataListener | null): void {
  metadataListener = listener
}

export function setPermissionModeChangedListener(listener: PermissionModeListener | null): void {
  permissionModeListener = listener
}
