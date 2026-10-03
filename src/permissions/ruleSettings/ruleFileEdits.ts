/**
 * Adding, replacing and removing rules in a user, project or local settings
 * file. Every edit goes through `editPermissionSettings`, which also refuses
 * any other source. The managed-only lock on new rules is decided here, for
 * the dialogs and for saved updates alike.
 */
import type { EditableSettingSource } from 'src/platform/settings/constants.js'
import { getSettingsForSource } from 'src/platform/settings/settings.js'
import type {
  PermissionBehavior,
  PermissionRuleValue,
} from 'src/permissions/PermissionRule.js'
import { managedRulesOnly } from 'src/permissions/ruleSettings/readRules.js'
import {
  canonicalRuleList,
  withRulesAppended,
  withRulesRemoved,
} from 'src/permissions/ruleSettings/ruleLists.js'
import {
  editPermissionSettings,
  listAsWritten,
} from 'src/permissions/ruleSettings/settingsFileEdit.js'

type RuleFileEdit = {
  ruleValues: readonly PermissionRuleValue[]
  ruleBehavior: PermissionBehavior
}

/**
 * While the managed layer allows only its own rules, no rule may be saved to
 * another file: it would come into force the moment the lock is lifted.
 */
function newRulesLocked(): boolean {
  return managedRulesOnly()
}

export function appendRulesToFile(
  { ruleValues, ruleBehavior }: RuleFileEdit,
  source: EditableSettingSource,
): boolean {
  if (newRulesLocked()) return false
  if (ruleValues.length === 0) return true
  const outcome = editPermissionSettings(source, permissions => {
    const next = withRulesAppended(listAsWritten(permissions, ruleBehavior) ?? [], ruleValues)
    return next ? { [ruleBehavior]: next } : null
  })
  return outcome === 'written' || outcome === 'unchanged'
}

export function replaceRulesInFile(
  { ruleValues, ruleBehavior }: RuleFileEdit,
  source: EditableSettingSource,
): boolean {
  if (newRulesLocked()) return false
  const outcome = editPermissionSettings(source, permissions => {
    const next = canonicalRuleList(ruleValues)
    const current = listAsWritten(permissions, ruleBehavior)
    const same = current?.length === next.length && next.every((rule, at) => current[at] === rule)
    return same ? null : { [ruleBehavior]: next }
  })
  return outcome === 'written' || outcome === 'unchanged'
}

/** Removal never creates a file or a list: nothing is written when nothing goes. */
export function removeRulesFromFile(
  { ruleValues, ruleBehavior }: RuleFileEdit,
  source: EditableSettingSource,
): boolean {
  const outcome = editPermissionSettings(source, permissions => {
    const current = listAsWritten(permissions, ruleBehavior)
    const next = current && withRulesRemoved(current, ruleValues)
    return next ? { [ruleBehavior]: next } : null
  })
  return outcome === 'written'
}

/**
 * Deleting a rule the user picked from the loaded rules. A file that fails
 * validation loads no rules, so it has none to give up and is left alone.
 */
export function deleteLoadedRule(rule: {
  source: EditableSettingSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}): boolean {
  const { source, ruleBehavior, ruleValue } = rule
  if (getSettingsForSource(source) === null) return false
  return removeRulesFromFile({ ruleValues: [ruleValue], ruleBehavior }, source)
}
