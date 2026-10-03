import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import {
  APPLY_PATCH_TOOL_NAME,
  LEGACY_APPLY_PATCH_TOOL_NAME,
} from 'src/tools/ApplyPatchTool/prompt.js'
import { TASK_OUTPUT_TOOL_NAME } from 'src/tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from 'src/tools/TaskStopTool/prompt.js'
import type { PermissionRuleValue } from 'src/permissions/PermissionRule.js'

// A Map rather than an object literal: lookups never reach inherited members,
// so a tool called `constructor` or `__proto__` stays a plain name.
const RENAMED_TOOLS: ReadonlyMap<string, string> = new Map([
  ['Task', AGENT_TOOL_NAME],
  ['KillShell', TASK_STOP_TOOL_NAME],
  ['AgentOutputTool', TASK_OUTPUT_TOOL_NAME],
  ['BashOutputTool', TASK_OUTPUT_TOOL_NAME],
  [LEGACY_APPLY_PATCH_TOOL_NAME, APPLY_PATCH_TOOL_NAME],
])

/** Content that stands for the whole tool rather than a scoped rule. */
const TOOL_WIDE_CONTENT = new Set(['', '*'])

export function normalizeLegacyToolName(name: string): string {
  return RENAMED_TOOLS.get(name) ?? name
}

export function getLegacyToolNames(canonicalName: string): string[] {
  const oldNames: string[] = []
  for (const [oldName, currentName] of RENAMED_TOOLS) {
    if (currentName === canonicalName) oldNames.push(oldName)
  }
  return oldNames
}

export function escapeRuleContent(content: string): string {
  return content.replace(/[\\()]/g, special => `\\${special}`)
}

export function unescapeRuleContent(content: string): string {
  // One left-to-right pass, so `\\(` reads as a backslash then a paren. Any
  // other backslash is kept, which makes this the exact inverse of escaping.
  return content.replace(/\\([\\()])/g, (_pair, literal: string) => literal)
}

type Delimiters = { open: number; close: number }

/**
 * Finds the first unescaped `(` and the last unescaped `)`. A backslash
 * consumes the character after it, so a paren behind an odd run of
 * backslashes never counts as a delimiter.
 */
function scanDelimiters(rule: string): Delimiters {
  const found: Delimiters = { open: -1, close: -1 }
  for (let at = 0; at < rule.length; at++) {
    const char = rule[at]
    if (char === '\\') {
      at++
    } else if (char === '(') {
      if (found.open < 0) found.open = at
    } else if (char === ')') {
      found.close = at
    }
  }
  return found
}

export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  const { open, close } = scanDelimiters(ruleString)
  const splits = open > 0 && close > open && close === ruleString.length - 1
  // A string that cannot be split is kept whole as the tool name. It matches
  // no real tool, and reading more into it could turn an inert rule live.
  if (!splits) return { toolName: normalizeLegacyToolName(ruleString) }

  const toolName = normalizeLegacyToolName(ruleString.slice(0, open))
  const rawContent = ruleString.slice(open + 1, close)
  if (TOOL_WIDE_CONTENT.has(rawContent)) return { toolName }
  return { toolName, ruleContent: unescapeRuleContent(rawContent) }
}

export function permissionRuleValueToString(
  ruleValue: PermissionRuleValue,
): string {
  const { toolName, ruleContent } = ruleValue
  if (!ruleContent) return toolName
  return `${toolName}(${escapeRuleContent(ruleContent)})`
}

/**
 * The one spelling of a rule: read, then written back. Two rule strings name
 * the same rule exactly when their canonical forms are equal, so every
 * comparison of stored rules goes through this.
 */
export function canonicalRuleString(ruleString: string): string {
  return permissionRuleValueToString(permissionRuleValueFromString(ruleString))
}

/** The canonical string of a rule value (`{ Bash, '*' }` → `Bash`). */
export function canonicalRuleValueString(ruleValue: PermissionRuleValue): string {
  return canonicalRuleString(permissionRuleValueToString(ruleValue))
}
