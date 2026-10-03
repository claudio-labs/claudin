import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import { liveRuleAnchors } from 'src/permissions/filePermissions/fileRules/anchors.js'
import { ruleCoveringAny } from 'src/permissions/filePermissions/fileRules/ruleQuery.js'
import { fileRulesOf } from 'src/permissions/filePermissions/fileRules/ruleSelection.js'
import {
  patternsByAnchor,
  patternsForSearchRoot,
} from 'src/permissions/filePermissions/fileRules/searchPatterns.js'
import { expandPath } from 'src/shared/fs/path.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

// The anchoring and matching live in ./fileRules/; this file keeps the
// exported names where their callers import them.

/**
 * Patterns for the search tools rooted at `root`, built from the map that
 * `getFileReadIgnorePatterns` returns.
 */
export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  return patternsForSearchRoot(patternsByRoot, root)
}

/** The `Read` deny patterns, keyed by the directory each one is anchored at (null: unanchored). */
export function getFileReadIgnorePatterns(
  toolPermissionContext: ToolPermissionContext,
): Map<string | null, string[]> {
  return patternsByAnchor(fileRulesOf(toolPermissionContext, 'read', 'deny'), liveRuleAnchors())
}

export function matchingRuleForInput(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  return ruleCoveringAny([expandPath(path)], toolPermissionContext, toolType, behavior)
}
