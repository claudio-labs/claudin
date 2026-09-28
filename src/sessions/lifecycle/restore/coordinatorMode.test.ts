/**
 * The coordinator-mode effects of a resume. `feature()` is false under
 * `bun test`, so the gated branches cannot run here: these tests pin the
 * gate itself and the pure pieces behind it.
 */
import { describe, expect, test } from 'bun:test'

import { createUserMessage } from 'src/agent/messages/messages.js'
import { agent, definitions } from 'src/sessions/__testutils__/restoreHarness.js'
import {
  currentMode,
  enterSessionMode,
  withCliAgents,
} from 'src/sessions/lifecycle/restore/coordinatorMode.js'
import type { SessionModeApi } from 'src/sessions/lifecycle/restore/types.js'

function modeApi(coordinator: boolean, onMatch: () => string | undefined = () => undefined): SessionModeApi {
  return { matchSessionMode: onMatch, isCoordinatorMode: () => coordinator }
}

describe('coordinator mode on resume', () => {
  test('the mode recorded is coordinator only when the mode API says so', () => {
    expect([currentMode(null), currentMode(modeApi(false)), currentMode(modeApi(true))]).toEqual([
      'normal',
      'normal',
      'coordinator',
    ])
  })

  test('agents given on the command line join the reloaded ones, and win over one of the same name', () => {
    const fromSettings = agent('reviewer')
    const scout = agent('scout')
    const fromCli = agent('reviewer', { source: 'flagSettings' })

    const merged = withCliAgents(definitions([fromSettings, scout]), [fromCli])

    expect(merged.allAgents).toEqual([fromSettings, scout, fromCli])
    expect(merged.activeAgents).toContain(fromCli)
    expect(merged.activeAgents).toContain(scout)
    expect(merged.activeAgents).not.toContain(fromSettings)
  })

  test('without the COORDINATOR_MODE build the session mode is never matched', () => {
    const messages = [createUserMessage({ content: 'Resume me.' })]
    let asked = false
    const api = modeApi(true, () => {
      asked = true
      return 'Switched to coordinator mode.'
    })

    const switched = enterSessionMode({ messages, mode: 'coordinator' }, api)

    expect([switched, asked, messages.length]).toEqual([false, false, 1])
  })
})
