import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import { getAllowRules, getAskRules, getDenyRules } from 'src/permissions/permissions/ruleLookup.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

export type FileAccess = 'read' | 'edit'
export type RuleBehavior = 'allow' | 'deny' | 'ask'

/** A rule that names a path pattern, with that pattern as written. */
export type FileRule = {
  readonly rule: PermissionRule
  readonly text: string
}

const TOOL_OF_ACCESS: Record<FileAccess, string> = {
  read: FILE_READ_TOOL_NAME,
  edit: FILE_EDIT_TOOL_NAME,
}

const RULES_OF_BEHAVIOR: Record<RuleBehavior, (context: ToolPermissionContext) => PermissionRule[]> = {
  allow: getAllowRules,
  deny: getDenyRules,
  ask: getAskRules,
}

/**
 * The `Read` or `Edit` rules of one behaviour that carry a pattern, in source
 * order. Deny and ask rules all count, each with its own source's anchor (F2).
 * Allow rules with the same text collapse to the last source's (F2, pinned):
 * honouring every copy would widen what existing allow rules grant.
 */
export function fileRulesOf(
  context: ToolPermissionContext,
  access: FileAccess,
  behavior: RuleBehavior,
): FileRule[] {
  const toolName = TOOL_OF_ACCESS[access]
  const rules: FileRule[] = []
  for (const rule of RULES_OF_BEHAVIOR[behavior](context)) {
    const text = rule.ruleValue.ruleContent
    if (rule.ruleValue.toolName === toolName && text) rules.push({ rule, text })
  }
  return behavior === 'allow' ? keepLastPerText(rules) : rules
}

function keepLastPerText(rules: readonly FileRule[]): FileRule[] {
  const byText = new Map<string, FileRule>()
  for (const entry of rules) byText.set(entry.text, entry)
  return [...byText.values()]
}
