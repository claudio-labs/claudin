/**
 * Finds specific allow rules that can never take effect, because a tool-wide
 * deny or ask rule for the same tool is consulted first.
 */
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import type { PermissionRule, PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import {
  getAllowRules,
  getAskRules,
  getDenyRules,
  permissionRuleSourceDisplayString,
} from 'src/permissions/permissions.js'

export type ShadowType = 'ask' | 'deny'

export type UnreachableRule = {
  rule: PermissionRule
  reason: string
  shadowedBy: PermissionRule
  shadowType: ShadowType
  fix: string
}

export type DetectUnreachableRulesOptions = {
  sandboxAutoAllowEnabled: boolean
}

/** Sources checked into a repository or pushed by an administrator, rather than chosen by this user. */
const SHARED_SOURCES: ReadonlySet<PermissionRuleSource> = new Set<PermissionRuleSource>([
  'projectSettings',
  'policySettings',
  'command',
])

export function isSharedSettingSource(source: PermissionRuleSource): boolean {
  return SHARED_SOURCES.has(source)
}

type Shadow = { by: PermissionRule; type: ShadowType }

const REASON_VERB: Record<ShadowType, string> = {
  deny: 'Blocked by',
  ask: 'Shadowed by',
}

function describeShadow(allow: PermissionRule, shadow: Shadow): UnreachableRule {
  const tool = shadow.by.ruleValue.toolName
  const shadowFrom = permissionRuleSourceDisplayString(shadow.by.source)
  const allowFrom = permissionRuleSourceDisplayString(allow.source)
  return {
    rule: allow,
    reason: `${REASON_VERB[shadow.type]} "${tool}" ${shadow.type} rule (from ${shadowFrom})`,
    shadowedBy: shadow.by,
    shadowType: shadow.type,
    fix: `Remove the "${tool}" ${shadow.type} rule from ${shadowFrom}, or remove the specific allow rule from ${allowFrom}`,
  }
}

const isToolWide = (rule: PermissionRule): boolean => rule.ruleValue.ruleContent === undefined

function firstToolWide(rules: PermissionRule[], toolName: string): PermissionRule | undefined {
  return rules.find(rule => isToolWide(rule) && rule.ruleValue.toolName === toolName)
}

/**
 * With the sandbox auto-allowing Bash, a personal tool-wide Bash ask does not
 * prompt for sandboxed commands, so it hides nothing. A shared one still counts.
 */
function askIsBypassedBySandbox(ask: PermissionRule, options: DetectUnreachableRulesOptions): boolean {
  return (
    options.sandboxAutoAllowEnabled &&
    ask.ruleValue.toolName === BASH_TOOL_NAME &&
    !isSharedSettingSource(ask.source)
  )
}

function findShadow(
  allow: PermissionRule,
  deny: PermissionRule[],
  ask: PermissionRule[],
  options: DetectUnreachableRulesOptions,
): Shadow | null {
  const toolName = allow.ruleValue.toolName
  const denying = firstToolWide(deny, toolName)
  if (denying) return { by: denying, type: 'deny' }
  const asking = firstToolWide(ask, toolName)
  if (!asking || askIsBypassedBySandbox(asking, options)) return null
  return { by: asking, type: 'ask' }
}

export function detectUnreachableRules(
  context: ToolPermissionContext,
  options: DetectUnreachableRulesOptions,
): UnreachableRule[] {
  const deny = getDenyRules(context)
  const ask = getAskRules(context)
  const found: UnreachableRule[] = []
  for (const allow of getAllowRules(context)) {
    if (isToolWide(allow)) continue
    const shadow = findShadow(allow, deny, ask, options)
    if (shadow) found.push(describeShadow(allow, shadow))
  }
  return found
}
