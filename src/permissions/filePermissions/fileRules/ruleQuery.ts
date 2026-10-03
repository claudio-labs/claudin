import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import { liveRuleAnchors } from 'src/permissions/filePermissions/fileRules/anchors.js'
import { findCoveringRule } from 'src/permissions/filePermissions/fileRules/ruleMatcher.js'
import {
  fileRulesOf,
  type FileAccess,
  type FileRule,
  type RuleBehavior,
} from 'src/permissions/filePermissions/fileRules/ruleSelection.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

/** The first rule of the context that covers any of the absolute `paths`. */
export function ruleCoveringAny(
  paths: readonly string[],
  context: ToolPermissionContext,
  access: FileAccess,
  behavior: RuleBehavior,
): PermissionRule | null {
  return ruleAmongCoveringAny(paths, fileRulesOf(context, access, behavior), behavior)
}

/** The same question over a caller-chosen subset of the rules. */
export function ruleAmongCoveringAny(
  paths: readonly string[],
  rules: readonly FileRule[],
  behavior: RuleBehavior,
): PermissionRule | null {
  if (rules.length === 0) return null
  const anchors = liveRuleAnchors()
  for (const path of paths) {
    const hit = findCoveringRule(path, rules, anchors, behavior)
    if (hit) return hit
  }
  return null
}
