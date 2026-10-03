/**
 * Fix 3 of the decision spec: under a managed-only policy, re-syncing the
 * rules also drops what a `--settings` file loaded. The characterization
 * suite leaves flag rules open on purpose; this file pins the fix.
 */
import { syncPermissionRulesFromDisk } from 'src/permissions/permissions.js'
import { describe, expect, test } from 'bun:test'

import { permissionContext, useDecisionWorld } from 'src/permissions/__testutils__/decisionWorld.js'

const world = useDecisionWorld()

const held = () =>
  permissionContext({
    alwaysAllowRules: { flagSettings: ['FlagAllow'], policySettings: ['Policy'], command: ['Cmd'] },
    alwaysDenyRules: { flagSettings: ['FlagDeny'] },
    alwaysAskRules: { session: ['Sess'] },
  })

describe('syncPermissionRulesFromDisk and --settings rules', () => {
  const cases: Array<[string, boolean, unknown]> = [
    [
      'a managed-only policy drops them, where they are held',
      true,
      { allow: [], deny: [], ask: undefined, command: ['Cmd'], policy: ['Policy'] },
    ],
    [
      'any other policy keeps them',
      false,
      { allow: ['FlagAllow'], deny: ['FlagDeny'], ask: undefined, command: ['Cmd'], policy: ['Policy'] },
    ],
  ]
  test.each(cases)('%s', (_what, managedOnly, expected) => {
    world().settings('policy', { allowManagedPermissionRulesOnly: managedOnly })
    const before = held()
    const after = syncPermissionRulesFromDisk(before, [])
    expect({
      allow: after.alwaysAllowRules.flagSettings,
      deny: after.alwaysDenyRules.flagSettings,
      ask: after.alwaysAskRules.flagSettings,
      command: after.alwaysAllowRules.command,
      policy: after.alwaysAllowRules.policySettings,
    }).toEqual(expected as never)
    expect(before.alwaysAllowRules.flagSettings).toEqual(['FlagAllow'])
  })
})
