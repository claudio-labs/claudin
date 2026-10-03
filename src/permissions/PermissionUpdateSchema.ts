import z from 'zod/v4'
// Imported by shared/types/hooks.ts: keep this module to schemas only.
import type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from 'src/shared/types/permissions.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { externalPermissionModeSchema } from 'src/permissions/PermissionMode.js'
import {
  permissionBehaviorSchema,
  permissionRuleValueSchema,
} from 'src/permissions/PermissionRule.js'

export type { PermissionUpdate, PermissionUpdateDestination }

// The managed layer, --settings and `command` are absent on purpose: nothing
// a host sends may write to them.
export const permissionUpdateDestinationSchema = lazySchema(() =>
  z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
)

function ruleListUpdate<Kind extends 'addRules' | 'replaceRules' | 'removeRules'>(kind: Kind) {
  return z.object({
    type: z.literal(kind),
    rules: z.array(permissionRuleValueSchema()),
    behavior: permissionBehaviorSchema(),
    destination: permissionUpdateDestinationSchema(),
  })
}

function directoryUpdate<Kind extends 'addDirectories' | 'removeDirectories'>(kind: Kind) {
  return z.object({
    type: z.literal(kind),
    directories: z.array(z.string()),
    destination: permissionUpdateDestinationSchema(),
  })
}

export const permissionUpdateSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    ruleListUpdate('addRules'),
    ruleListUpdate('replaceRules'),
    ruleListUpdate('removeRules'),
    z.object({
      type: z.literal('setMode'),
      mode: externalPermissionModeSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    directoryUpdate('addDirectories'),
    directoryUpdate('removeDirectories'),
  ]),
)
