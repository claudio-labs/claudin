import { afterEach, describe, expect, test } from 'bun:test'
import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from 'src/platform/bootstrap/state.js'
import { selectTurnModel } from 'src/agent/query/turnModel.js'
import { getDefaultOpusModel } from 'src/providers/model/model.js'

const SAVED_OVERRIDE = getMainLoopModelOverride()
afterEach(() => {
  setMainLoopModelOverride(SAVED_OVERRIDE)
})

const base = {
  agentModel: 'claude-haiku-4-5-20251001',
  sessionModel: 'claude-opus-5-5',
  permissionMode: 'default' as const,
  exceeds200kTokens: false,
}

// A spawned agent's app state is its parent's, so reading the model from it
// ran every spawned agent on the parent's model (E2E 2026-09-25: an Explore
// child asked for haiku, and defined as sonnet, both answered as Opus).
describe('selectTurnModel', () => {
  test('a spawned agent calls the model it was resolved to', () => {
    expect(selectTurnModel({ ...base, agentType: 'Explore' })).toBe(
      'claude-haiku-4-5-20251001',
    )
  })

  test('the main thread and internal forks follow the session model', () => {
    expect(selectTurnModel({ ...base, agentType: undefined })).toBe('claude-opus-5-5')
  })

  test('the plan-mode swap applies to the session, not to a spawned agent', () => {
    setMainLoopModelOverride('opusplan')
    const plan = { ...base, sessionModel: 'claude-sonnet-5', permissionMode: 'plan' as const }
    expect(selectTurnModel({ ...plan, agentType: undefined })).toBe(getDefaultOpusModel())
    expect(selectTurnModel({ ...plan, agentType: 'Explore' })).toBe(
      'claude-haiku-4-5-20251001',
    )
  })
})
