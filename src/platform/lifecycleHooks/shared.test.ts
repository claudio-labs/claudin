import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  getMainThreadAgentType,
  setMainThreadAgentType,
} from 'src/platform/bootstrap/state.js'
import { createBaseHookInput } from 'src/platform/lifecycleHooks/shared.js'

/**
 * `createBaseHookInput` builds the payload every hook event carries, and until
 * now it was only pinned structurally — `publicSurface.characterization.test.ts`
 * asserts it exists and is a function, which stays true however the body is
 * rewritten. These are the claims a hook consumer actually depends on.
 *
 * `shouldSkipHookDueToTrust` next to it is deliberately NOT covered here: its
 * two inputs are `getIsNonInteractiveSession()` and `checkHasTrustDialogAccepted()`,
 * and the only way to drive them from a test is `mock.module` over
 * `src/platform/config/config.js` — the module `.claudin/rules/testing.md` names
 * as the known cross-file mock leak. A test that poisons the suite costs more
 * than the assertion is worth.
 */
describe('createBaseHookInput', () => {
  // `mainThreadAgentType` is process-global and defaults to undefined under the
  // runner, which makes the precedence below indistinguishable from its own
  // inversion unless something is actually set. Restored in afterAll: a file
  // that leaves this set owns it for every file bun reaches afterwards.
  const savedAgentType = getMainThreadAgentType()
  beforeAll(() => setMainThreadAgentType('session-wide-agent'))
  afterAll(() => setMainThreadAgentType(savedAgentType))

  test('uses the session id it is handed rather than the ambient one', () => {
    const input = createBaseHookInput(undefined, 'session-under-test')
    expect(input.session_id).toBe('session-under-test')
    expect(input.transcript_path).toContain('session-under-test')
  })

  // The precedence is load-bearing: hooks distinguish a subagent call from a
  // main-thread call in an --agent session, so the subagent's own type has to
  // win over the session-wide one.
  test("a subagent's own type wins over the session's agent type", () => {
    const input = createBaseHookInput(undefined, 'sid', {
      agentId: 'agent-7',
      agentType: 'code-reviewer',
    })
    expect(input.agent_type).toBe('code-reviewer')
    expect(input.agent_id).toBe('agent-7')
  })

  test("falls back to the session's agent type when there is no subagent", () => {
    const input = createBaseHookInput(undefined, 'sid')
    expect(input.agent_type).toBe('session-wide-agent')
    expect(input.agent_id).toBeUndefined()
  })

  test('passes the permission mode through untouched', () => {
    expect(createBaseHookInput('acceptEdits', 'sid').permission_mode).toBe(
      'acceptEdits',
    )
  })

  test('carries a cwd and a transcript path on every payload', () => {
    const input = createBaseHookInput(undefined, 'sid')
    expect(input.cwd.length).toBeGreaterThan(0)
    expect(input.transcript_path.length).toBeGreaterThan(0)
  })
})
