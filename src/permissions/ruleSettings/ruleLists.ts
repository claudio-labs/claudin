/**
 * Pure edits of a rule list as written in a settings file. Entries are
 * compared by canonical form, so a rule cannot survive an edit, or be added
 * twice, by being spelled another way. Entries that are not strings are kept
 * untouched.
 */
import type { PermissionRuleValue } from 'src/permissions/PermissionRule.js'
import {
  canonicalRuleString,
  canonicalRuleValueString,
} from 'src/permissions/permissionRuleParser.js'

function canonicalEntries(list: readonly unknown[]): Set<string> {
  const seen = new Set<string>()
  for (const entry of list) {
    if (typeof entry === 'string') seen.add(canonicalRuleString(entry))
  }
  return seen
}

/**
 * The list with every rule not yet in it appended, in canonical form and
 * once each. null when every rule is already there.
 */
export function withRulesAppended(
  list: readonly unknown[],
  additions: readonly PermissionRuleValue[],
): unknown[] | null {
  const present = canonicalEntries(list)
  const appended: string[] = []
  for (const value of additions) {
    const canonical = canonicalRuleValueString(value)
    if (present.has(canonical)) continue
    present.add(canonical)
    appended.push(canonical)
  }
  return appended.length > 0 ? [...list, ...appended] : null
}

/** The list without any entry naming one of `rules`. null when none was there. */
export function withRulesRemoved(
  list: readonly unknown[],
  rules: readonly PermissionRuleValue[],
): unknown[] | null {
  const doomed = new Set(rules.map(canonicalRuleValueString))
  const kept = list.filter(
    entry => typeof entry !== 'string' || !doomed.has(canonicalRuleString(entry)),
  )
  return kept.length < list.length ? kept : null
}

/** The rules in canonical form, once each, in their first order. */
export function canonicalRuleList(rules: readonly PermissionRuleValue[]): string[] {
  return [...new Set(rules.map(canonicalRuleValueString))]
}
