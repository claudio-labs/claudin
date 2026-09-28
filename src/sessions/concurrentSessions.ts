// This process's record under <config dir>/sessions/, and the other running
// sessions read from theirs. Callers import from this path; the code is in
// lifecycle/processRecord/.
export {
  countConcurrentSessions,
  type LiveSession,
  listLiveSessions,
} from 'src/sessions/lifecycle/processRecord/liveSessions.js'
export {
  updateSessionBridgeId,
  updateSessionCwd,
  updateSessionInbox,
  updateSessionName,
  updateSessionPresence,
  updateSessionStatus,
} from 'src/sessions/lifecycle/processRecord/recordUpdates.js'
export {
  registerSession,
  whenSessionRegistered,
} from 'src/sessions/lifecycle/processRecord/registration.js'
