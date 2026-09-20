/**
 * Stripping dangerous allow rules on the way into auto mode, and putting them
 * back on the way out.
 *
 * The stash lives on the context (`strippedDangerousRules`), not in this
 * module — auto mode can be entered and left many times in a session, and a
 * module-level copy would drift from the context the caller actually holds.
 */
import type {
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from 'src/tools/Tool.js'
import { logForDebugging } from 'src/shared/debug.js'
import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from 'src/permissions/PermissionRule.js'
import { applyPermissionUpdate } from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdateDestination } from 'src/permissions/PermissionUpdateSchema.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from 'src/permissions/permissionRuleParser.js'
import {
  type DangerousPermissionInfo,
  findDangerousClassifierPermissions,
} from 'src/permissions/permissionSetup/dangerousRuleDetection.js'

/**
 * Type guard to check if a PermissionRuleSource is a valid PermissionUpdateDestination.
 * Sources like 'flagSettings', 'policySettings', and 'command' are not valid destinations.
 */
function isPermissionUpdateDestination(
  source: PermissionRuleSource,
): source is PermissionUpdateDestination {
  return [
    'userSettings',
    'projectSettings',
    'localSettings',
    'session',
    'cliArg',
  ].includes(source)
}

/**
 * Removes dangerous permissions from the in-memory context, and optionally
 * persists the removal to settings files on disk.
 */
export function removeDangerousPermissions(
  context: ToolPermissionContext,
  dangerousPermissions: DangerousPermissionInfo[],
): ToolPermissionContext {
  // Group dangerous rules by their source (destination for updates)
  const rulesBySource = new Map<
    PermissionUpdateDestination,
    PermissionRuleValue[]
  >()
  for (const perm of dangerousPermissions) {
    // Skip sources that can't be persisted (flagSettings, policySettings, command)
    if (!isPermissionUpdateDestination(perm.source)) {
      continue
    }
    const destination = perm.source
    const existing = rulesBySource.get(destination) || []
    existing.push(perm.ruleValue)
    rulesBySource.set(destination, existing)
  }

  let updatedContext = context
  for (const [destination, rules] of rulesBySource) {
    updatedContext = applyPermissionUpdate(updatedContext, {
      type: 'removeRules' as const,
      rules,
      behavior: 'allow' as const,
      destination,
    })
  }

  return updatedContext
}

/**
 * Prepares a ToolPermissionContext for auto mode by stripping
 * dangerous permissions that would bypass the classifier.
 * Returns the cleaned context (with mode unchanged — caller sets the mode).
 */
export function stripDangerousPermissionsForAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const rules: PermissionRule[] = []
  for (const [source, ruleStrings] of Object.entries(
    context.alwaysAllowRules,
  )) {
    if (!ruleStrings) {
      continue
    }
    for (const ruleString of ruleStrings) {
      const ruleValue = permissionRuleValueFromString(ruleString)
      rules.push({
        source: source as PermissionRuleSource,
        ruleBehavior: 'allow',
        ruleValue,
      })
    }
  }
  const dangerousPermissions = findDangerousClassifierPermissions(rules, [])
  if (dangerousPermissions.length === 0) {
    return {
      ...context,
      strippedDangerousRules: context.strippedDangerousRules ?? {},
    }
  }
  for (const permission of dangerousPermissions) {
    logForDebugging(
      `Ignoring dangerous permission ${permission.ruleDisplay} from ${permission.sourceDisplay} (bypasses classifier)`,
    )
  }
  // Mirror removeDangerousPermissions' source filter so stash == what was actually removed.
  const stripped: ToolPermissionRulesBySource = {}
  for (const perm of dangerousPermissions) {
    if (!isPermissionUpdateDestination(perm.source)) continue
    ;(stripped[perm.source] ??= []).push(
      permissionRuleValueToString(perm.ruleValue),
    )
  }
  return {
    ...removeDangerousPermissions(context, dangerousPermissions),
    strippedDangerousRules: stripped,
  }
}

/**
 * Restores dangerous allow rules previously stashed by
 * stripDangerousPermissionsForAutoMode. Called when leaving auto mode so that
 * the user's Bash(python:*), Agent(*), etc. rules work again in default mode.
 * Clears the stash so a second exit is a no-op.
 */
export function restoreDangerousPermissions(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const stash = context.strippedDangerousRules
  if (!stash) {
    return context
  }
  let result = context
  for (const [source, ruleStrings] of Object.entries(stash)) {
    if (!ruleStrings || ruleStrings.length === 0) continue
    result = applyPermissionUpdate(result, {
      type: 'addRules',
      rules: ruleStrings.map(permissionRuleValueFromString),
      behavior: 'allow',
      destination: source as PermissionUpdateDestination,
    })
  }
  return { ...result, strippedDangerousRules: undefined }
}
