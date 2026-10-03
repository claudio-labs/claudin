/**
 * Where a rule string sits in a `ToolPermissionContext`: one list per kind
 * (allow, deny, ask) and per source. Lookups read these slots in
 * `RULE_SOURCES` order; mutations replace one slot at a time and never touch
 * the context they were given.
 */
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { SETTING_SOURCES } from 'src/platform/settings/constants.js'
import type {
  PermissionBehavior,
  PermissionRuleSource,
} from 'src/permissions/PermissionRule.js'

const SESSION_SCOPED_SOURCES = ['cliArg', 'command', 'session'] as const

/** Lowest precedence first. A rule found earlier in this order is the one reported. */
export const RULE_SOURCES: readonly PermissionRuleSource[] = [
  ...SETTING_SOURCES,
  ...SESSION_SCOPED_SOURCES,
]

export const RULE_KINDS: readonly PermissionBehavior[] = ['allow', 'deny', 'ask']

type RulesKey = 'alwaysAllowRules' | 'alwaysDenyRules' | 'alwaysAskRules'

type Slots = ToolPermissionContext[RulesKey]

const SLOT_KEY: Readonly<Record<PermissionBehavior, RulesKey>> = {
  allow: 'alwaysAllowRules',
  deny: 'alwaysDenyRules',
  ask: 'alwaysAskRules',
}

export function rulesBySource(
  context: ToolPermissionContext,
  kind: PermissionBehavior,
): Slots {
  return context[SLOT_KEY[kind]]
}

export function slotHolds(
  context: ToolPermissionContext,
  kind: PermissionBehavior,
  source: PermissionRuleSource,
): boolean {
  return rulesBySource(context, kind)[source] !== undefined
}

/** A copy of `context` whose one slot is `rules`. */
export function withSlot(
  context: ToolPermissionContext,
  kind: PermissionBehavior,
  source: PermissionRuleSource,
  rules: string[],
): ToolPermissionContext {
  const slots: Slots = {
    ...rulesBySource(context, kind),
    [source]: rules,
  }
  switch (SLOT_KEY[kind]) {
    case 'alwaysAllowRules':
      return { ...context, alwaysAllowRules: slots }
    case 'alwaysDenyRules':
      return { ...context, alwaysDenyRules: slots }
    case 'alwaysAskRules':
      return { ...context, alwaysAskRules: slots }
  }
}
