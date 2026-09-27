import { afterEach, describe, expect, test } from 'bun:test'
import { getSessionId, switchSession } from 'src/platform/bootstrap/state.js'
import {
  closeInstanceSession,
  getInstanceSessionIds,
  resetInstanceSessionsForTests,
  trackInstanceSessions,
} from 'src/sessions/instanceSessions.js'
import type { SessionId } from 'src/shared/types/ids.js'

describe('instance sessions', () => {
  const original = getSessionId()

  afterEach(() => {
    resetInstanceSessionsForTests()
    switchSession(original)
  })

  test('records every session switched to, most recent first, once each', () => {
    trackInstanceSessions()
    switchSession('b' as SessionId)
    switchSession('c' as SessionId)
    switchSession('b' as SessionId)
    expect(getInstanceSessionIds()).toEqual(['b', 'c', original])
  })

  test('records nothing before tracking starts', () => {
    switchSession('b' as SessionId)
    expect(getInstanceSessionIds()).toEqual([])
    trackInstanceSessions()
    expect(getInstanceSessionIds()).toEqual(['b'])
  })

  test('an ended session leaves the list; a later visit brings it back', () => {
    trackInstanceSessions()
    switchSession('b' as SessionId)
    closeInstanceSession(original)
    expect(getInstanceSessionIds()).toEqual(['b'])
    switchSession(original)
    expect(getInstanceSessionIds()).toEqual([original, 'b'])
  })
})
