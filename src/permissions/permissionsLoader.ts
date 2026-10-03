/**
 * The permission rules on disk: reading them from the settings layers, and
 * editing them in the user, project and local files. The work is done in
 * `ruleSettings/`; this module is the contract its callers import.
 */
import type {
  EditableSettingSource,
  SettingSource,
} from 'src/platform/settings/constants.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
} from 'src/permissions/PermissionRule.js'
import {
  managedRulesOnly,
  rulesOfEveryLayer,
  rulesOfLayer,
} from 'src/permissions/ruleSettings/readRules.js'
import {
  appendRulesToFile,
  deleteLoadedRule,
} from 'src/permissions/ruleSettings/ruleFileEdits.js'

export function shouldAllowManagedPermissionRulesOnly(): boolean {
  return managedRulesOnly()
}

/** The dialogs offer "always allow" only when another layer's rules count. */
export function shouldShowAlwaysAllowOptions(): boolean {
  return !managedRulesOnly()
}

export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  return rulesOfEveryLayer()
}

export function getPermissionRulesForSource(
  source: SettingSource,
): PermissionRule[] {
  return rulesOfLayer(source)
}

export type PermissionRuleFromEditableSettings = PermissionRule & {
  source: EditableSettingSource
}

export function deletePermissionRuleFromSettings(
  rule: PermissionRuleFromEditableSettings,
): boolean {
  return deleteLoadedRule(rule)
}

export function addPermissionRulesToSettings(
  {
    ruleValues,
    ruleBehavior,
  }: {
    ruleValues: PermissionRuleValue[]
    ruleBehavior: PermissionBehavior
  },
  source: EditableSettingSource,
): boolean {
  return appendRulesToFile({ ruleValues, ruleBehavior }, source)
}
