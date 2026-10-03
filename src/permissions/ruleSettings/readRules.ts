/**
 * Which permission rules are in force, read from the settings layers. The
 * layers, their files and their validation belong to platform/settings; this
 * module only turns what they return into rules.
 */
import {
  getEnabledSettingSources,
  type SettingSource,
} from 'src/platform/settings/constants.js'
import { getSettingsForSource } from 'src/platform/settings/settings.js'
import type { SettingsJson } from 'src/platform/settings/types.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
} from 'src/permissions/PermissionRule.js'
import { permissionRuleValueFromString } from 'src/permissions/permissionRuleParser.js'

const LOAD_ORDER: readonly PermissionBehavior[] = ['allow', 'deny', 'ask']

/**
 * Whether the managed layer has switched every other layer off. Only the
 * managed layer can say so, and only with the boolean `true`.
 */
export function managedRulesOnly(): boolean {
  return getSettingsForSource('policySettings')?.allowManagedPermissionRulesOnly === true
}

function rulesInSettings(
  settings: SettingsJson | null,
  source: PermissionRuleSource,
): PermissionRule[] {
  const permissions = settings?.permissions
  if (!permissions) return []
  const rules: PermissionRule[] = []
  for (const ruleBehavior of LOAD_ORDER) {
    for (const raw of permissions[ruleBehavior] ?? []) {
      rules.push({ source, ruleBehavior, ruleValue: permissionRuleValueFromString(raw) })
    }
  }
  return rules
}

export function rulesOfLayer(source: SettingSource): PermissionRule[] {
  return rulesInSettings(getSettingsForSource(source), source)
}

export function rulesOfEveryLayer(): PermissionRule[] {
  if (managedRulesOnly()) return rulesOfLayer('policySettings')
  return getEnabledSettingSources().flatMap(source => rulesOfLayer(source))
}
