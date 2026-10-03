/**
 * Decision details the characterization suites do not reach.
 */
import {
  checkRuleBasedPermissions,
  createPermissionRequestMessage,
  hasPermissionsToUseTool,
} from 'src/permissions/permissions.js'
import { expect, test } from 'bun:test'

import {
  ASSISTANT_TURN,
  makeCtx,
  messageOf,
  standIn,
  useDecisionWorld,
} from 'src/permissions/__testutils__/decisionWorld.js'

useDecisionWorld()

test('a whole-tool ask rule shows the default request, the rule riding only in the reason (finding 7)', async () => {
  const permissions = { alwaysAskRules: { projectSettings: ['Scribe'] } }
  const decided = await hasPermissionsToUseTool(
    standIn({ name: 'Scribe' }),
    {},
    makeCtx({ permissions }),
    ASSISTANT_TURN,
    'toolu_ask_rule',
  )
  const ruled = await checkRuleBasedPermissions(standIn({ name: 'Scribe' }), {}, makeCtx({ permissions }))
  expect([messageOf(decided), messageOf(ruled)]).toEqual(Array(2).fill(createPermissionRequestMessage('Scribe')))
  expect(decided.decisionReason?.type).toBe('rule')
})
