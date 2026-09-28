// The session's state (idle, running, blocked on the user) and its listeners.
// Callers import from this path; the code is in lifecycle/state/.
export {
  getSessionState,
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  notifySessionStateChanged,
  setPermissionModeChangedListener,
  setSessionMetadataChangedListener,
  setSessionStateChangedListener,
} from 'src/sessions/lifecycle/state/stateHolder.js'
export type {
  RequiresActionDetails,
  SessionExternalMetadata,
  SessionState,
} from 'src/sessions/lifecycle/state/types.js'
