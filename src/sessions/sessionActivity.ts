// Work in flight and the remote keep-alive heartbeat. Callers import from this
// path; the code is in lifecycle/activity.ts.
export {
  isSessionActivityTrackingActive,
  registerSessionActivityCallback,
  sendSessionActivitySignal,
  type SessionActivityReason,
  startSessionActivity,
  stopSessionActivity,
  unregisterSessionActivityCallback,
} from 'src/sessions/lifecycle/activity.js'
