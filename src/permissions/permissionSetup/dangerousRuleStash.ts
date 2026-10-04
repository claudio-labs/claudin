/**
 * Stripping dangerous allow rules on the way into auto mode, and putting them
 * back on the way out.
 *
 * The stash lives on the context (`strippedDangerousRules`), not in this
 * module — auto mode can be entered and left many times in a session, and a
 * module-level copy would drift from the context the caller actually holds.
 */
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { logForDebugging } from 'src/shared/debug.js'
import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from 'src/permissions/PermissionRule.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from 'src/permissions/permissionRuleParser.js'
import {
  type DangerousPermissionInfo,
  findDangerousClassifierPermissions,
} from 'src/permissions/permissionSetup/dangerousRuleDetection.js'

/**
 * Sources whose rules this session may take out and put back. Flag, policy
 * and command rules stay in force in auto mode (kept for parity, spec
 * finding 5). The removal and the stash both read this one set.
 */
const WRITABLE_SOURCES: ReadonlySet<PermissionRuleSource> = new Set<PermissionRuleSource>([
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
  'cliArg',
])

/**
 * One spelling per rule: `Bash`, `Bash()` and `Bash(*)` share a key, and so
 * do `Task(x)` and `Agent(x)`. Matching on it instead of the stored string is
 * what removes a non-canonical `--allowed-tools` entry (spec finding 1).
 */
const ruleKeyOfString = (stored: string): string =>
  permissionRuleValueToString(permissionRuleValueFromString(stored))

const ruleKeyOfValue = (value: PermissionRuleValue): string =>
  ruleKeyOfString(permissionRuleValueToString(value))

type KeysBySource = Map<PermissionRuleSource, Set<string>>

function writableKeys(findings: DangerousPermissionInfo[]): KeysBySource {
  const keys: KeysBySource = new Map()
  for (const { source, ruleValue } of findings) {
    if (!WRITABLE_SOURCES.has(source)) continue
    const forSource = keys.get(source) ?? new Set<string>()
    forSource.add(ruleKeyOfValue(ruleValue))
    keys.set(source, forSource)
  }
  return keys
}

const distinct = (strings: string[]): string[] => [...new Set(strings)]

/** Rule strings by source, as the context holds them (the context is deeply readonly). */
type RuleLists = { readonly [S in PermissionRuleSource]?: readonly string[] }
type RuleListsDraft = { [S in PermissionRuleSource]?: readonly string[] }

type Removal = { allow: RuleListsDraft; removed: RuleListsDraft }

/** Every copy of a matching string leaves its list; the rest keep their order. */
function removeByKey(allow: RuleLists, keys: KeysBySource): Removal {
  const next: RuleListsDraft = { ...allow }
  const removed: RuleListsDraft = {}
  for (const [source, sourceKeys] of keys) {
    const list = allow[source]
    if (!list) continue
    const taken = list.filter(stored => sourceKeys.has(ruleKeyOfString(stored)))
    if (taken.length === 0) continue
    next[source] = list.filter(stored => !sourceKeys.has(ruleKeyOfString(stored)))
    removed[source] = distinct(taken)
  }
  return { allow: next, removed }
}

const sourcesIn = (bySource: RuleLists): PermissionRuleSource[] =>
  Object.keys(bySource) as PermissionRuleSource[]

function allowRulesOf(context: ToolPermissionContext): PermissionRule[] {
  return sourcesIn(context.alwaysAllowRules).flatMap(source =>
    (context.alwaysAllowRules[source] ?? []).map(
      (stored): PermissionRule => ({
        source,
        ruleBehavior: 'allow',
        ruleValue: permissionRuleValueFromString(stored),
      }),
    ),
  )
}

/** Adds strings not already listed, per source, after the ones that are. */
function appendMissing(
  target: RuleLists,
  additions: RuleLists,
): RuleListsDraft {
  const merged: RuleListsDraft = { ...target }
  for (const source of sourcesIn(additions)) {
    const extra = additions[source] ?? []
    if (extra.length === 0) continue
    const list = [...(target[source] ?? [])]
    const listed = new Set(list)
    for (const stored of extra) {
      if (listed.has(stored)) continue
      list.push(stored)
      listed.add(stored)
    }
    merged[source] = list
  }
  return merged
}

export function removeDangerousPermissions(
  context: ToolPermissionContext,
  dangerousPermissions: DangerousPermissionInfo[],
): ToolPermissionContext {
  const keys = writableKeys(dangerousPermissions)
  if (keys.size === 0) return context
  return { ...context, alwaysAllowRules: removeByKey(context.alwaysAllowRules, keys).allow }
}

export function stripDangerousPermissionsForAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const findings = findDangerousClassifierPermissions(allowRulesOf(context), [])
  for (const finding of findings) {
    logForDebugging(
      `auto mode: allow rule ${finding.ruleDisplay} (${finding.source}) would bypass the classifier`,
    )
  }
  const { allow, removed } = removeByKey(context.alwaysAllowRules, writableKeys(findings))
  const previous = context.strippedDangerousRules
  if (sourcesIn(removed).length === 0) {
    return { ...context, strippedDangerousRules: previous ?? {} }
  }
  // A second strip adds to the stash: what the first one took is already out
  // of the lists, so replacing it would lose those rules (spec finding 2).
  return {
    ...context,
    alwaysAllowRules: allow,
    strippedDangerousRules: appendMissing(previous ?? {}, removed),
  }
}

export function restoreDangerousPermissions(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const stash = context.strippedDangerousRules
  if (!stash) return context
  // A rule re-added while in auto mode is not listed twice (spec finding 3).
  return {
    ...context,
    alwaysAllowRules: appendMissing(context.alwaysAllowRules, stash),
    strippedDangerousRules: undefined,
  }
}
