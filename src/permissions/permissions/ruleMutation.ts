/**
 * Changing the rules in force: pure transforms of a `ToolPermissionContext`,
 * plus the one write to a settings file that deleting a rule needs.
 */
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import type { EditableSettingSource } from 'src/platform/settings/constants.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
} from 'src/permissions/PermissionRule.js'
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js'
import {
  deletePermissionRuleFromSettings,
  shouldAllowManagedPermissionRulesOnly,
} from 'src/permissions/permissionsLoader.js'
import { permissionRuleSourceDisplayString } from 'src/permissions/permissions/ruleLookup.js'
import {
  RULE_KINDS,
  rulesBySource,
  slotHolds,
  withSlot,
} from 'src/permissions/permissions/ruleSlots.js'

/** Sources whose rules the user cannot remove from a running session. */
const LOCKED_SOURCES: ReadonlySet<PermissionRuleSource> = new Set([
  'policySettings',
  'flagSettings',
  'command',
])

/** The sources backed by a settings file this process may rewrite. */
const SETTINGS_FILE_SOURCES: readonly EditableSettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
]

function isSettingsFileSource(
  source: PermissionRuleSource,
): source is EditableSettingSource {
  return (SETTINGS_FILE_SOURCES as readonly PermissionRuleSource[]).includes(source)
}

function currentSlot(
  context: ToolPermissionContext,
  kind: PermissionBehavior,
  source: PermissionRuleSource,
): string[] {
  return [...(rulesBySource(context, kind)[source] ?? [])]
}

function emptySlotsFor(
  context: ToolPermissionContext,
  sources: readonly PermissionRuleSource[],
): ToolPermissionContext {
  let next = context
  for (const kind of RULE_KINDS) {
    for (const source of sources) next = withSlot(next, kind, source, [])
  }
  return next
}

export async function deletePermissionRule({
  rule,
  initialContext,
  setToolPermissionContext,
}: {
  rule: PermissionRule
  initialContext: ToolPermissionContext
  setToolPermissionContext: (updatedContext: ToolPermissionContext) => void
}): Promise<void> {
  const text = permissionRuleValueToString(rule.ruleValue)
  if (LOCKED_SOURCES.has(rule.source)) {
    throw new Error(
      `The rule '${text}' comes from ${permissionRuleSourceDisplayString(rule.source)}, which are read-only settings, so it cannot be deleted here.`,
    )
  }
  const remaining = currentSlot(initialContext, rule.ruleBehavior, rule.source).filter(
    held => held !== text,
  )
  const source = rule.source
  if (isSettingsFileSource(source)) {
    deletePermissionRuleFromSettings({ ...rule, source })
  }
  setToolPermissionContext(
    withSlot(initialContext, rule.ruleBehavior, source, remaining),
  )
}

export function applyPermissionRulesToPermissionContext(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  return rules.reduce(
    (context, rule) =>
      withSlot(context, rule.ruleBehavior, rule.source, [
        ...currentSlot(context, rule.ruleBehavior, rule.source),
        permissionRuleValueToString(rule.ruleValue),
      ]),
    toolPermissionContext,
  )
}

/**
 * Under a managed-only policy nothing but the policy (and the rules commands
 * carry) may stay in force: the CLI and session rules go, and so do rules a
 * `--settings` file loaded before the policy switched on. A flag slot is
 * emptied only where the context holds one.
 */
function lockToManagedRules(context: ToolPermissionContext): ToolPermissionContext {
  let next = emptySlotsFor(context, ['cliArg', 'session'])
  for (const kind of RULE_KINDS) {
    if (slotHolds(next, kind, 'flagSettings')) {
      next = withSlot(next, kind, 'flagSettings', [])
    }
  }
  return next
}

export function syncPermissionRulesFromDisk(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  let next = emptySlotsFor(toolPermissionContext, SETTINGS_FILE_SOURCES)
  if (shouldAllowManagedPermissionRulesOnly()) next = lockToManagedRules(next)

  const fromDisk = new Map<string, { rule: PermissionRule; texts: string[] }>()
  for (const rule of rules) {
    const slot = `${rule.ruleBehavior}:${rule.source}`
    const entry = fromDisk.get(slot) ?? { rule, texts: [] }
    entry.texts.push(permissionRuleValueToString(rule.ruleValue))
    fromDisk.set(slot, entry)
  }
  for (const { rule, texts } of fromDisk.values()) {
    next = withSlot(next, rule.ruleBehavior, rule.source, texts)
  }
  return next
}
