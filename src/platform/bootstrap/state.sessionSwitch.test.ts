import { expect, test } from 'bun:test'
import type { SessionId } from 'src/shared/types/ids.js'
import {
  getSessionId,
  onSessionSwitch,
  resetStateForTests,
  switchSession,
} from 'src/platform/bootstrap/state.js'

// resetStateForTests() used to call sessionSwitched.clear(). Its subscribers
// (stableStubState's clipped-id map, loopSentinels, concurrentSessions' PID
// file) all register once at module load and never re-register, so that one
// line unsubscribed them for the rest of the process — and because it only
// bites files that imported the module BEFORE the reset ran, it broke a
// different set of tests on CI than it did locally. Pinned here rather than
// only in stableStubState's own wiring test: the damage is to the signal, so
// this is the file that should go red if the clear ever comes back.
test('resetStateForTests leaves module-load session-switch listeners subscribed', () => {
  const original = getSessionId()
  const seen: string[] = []
  const unsubscribe = onSessionSwitch(id => {
    seen.push(id)
  })

  try {
    resetStateForTests()
    switchSession('after-reset-listener-probe' as SessionId)
    expect(seen).toEqual(['after-reset-listener-probe'])
  } finally {
    unsubscribe()
    switchSession(original)
  }
})
