import type { PermissionRuleValue } from 'src/permissions/PermissionRule.js'
import { extractRules } from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { UnreachableRule } from 'src/permissions/shadowedRuleDetection.js'

const sameRule = (a: PermissionRuleValue, b: PermissionRuleValue): boolean =>
  a.toolName === b.toolName && a.ruleContent === b.ruleContent

/**
 * Narrows the unreachable allow rules to the ones relevant to this request:
 * the rules it suggests when it suggests any, else the rules of its tool, else
 * every one of them.
 */
export function relevantUnreachableRules(
  rules: readonly UnreachableRule[],
  suggestions: readonly PermissionUpdate[] | undefined,
  toolName: string | undefined,
): UnreachableRule[] {
  const suggested = extractRules(suggestions ? [...suggestions] : undefined)
  if (suggested.length > 0) {
    return rules.filter(unreachable => suggested.some(rule => sameRule(rule, unreachable.rule.ruleValue)))
  }
  if (toolName) return rules.filter(unreachable => unreachable.rule.ruleValue.toolName === toolName)
  return [...rules]
}
