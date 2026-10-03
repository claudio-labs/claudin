/**
 * Reading the rules a session holds. Every function here is pure over the
 * `ToolPermissionContext` it is handed.
 */
import {
  getToolNameForPermissionCheck,
  mcpInfoFromString,
} from 'src/mcp/mcpStringUtils.js'
import type { Tool, ToolPermissionContext } from 'src/tools/Tool.js'
import { getSettingSourceDisplayNameLowercase } from 'src/platform/settings/constants.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
} from 'src/permissions/PermissionRule.js'
import { permissionRuleValueFromString } from 'src/permissions/permissionRuleParser.js'
import { RULE_SOURCES, rulesBySource } from 'src/permissions/permissions/ruleSlots.js'

type RuleTarget = Pick<Tool, 'name' | 'mcpInfo'>

export function permissionRuleSourceDisplayString(
  source: PermissionRuleSource,
): string {
  return getSettingSourceDisplayNameLowercase(source)
}

function listRules(
  context: ToolPermissionContext,
  kind: PermissionBehavior,
): PermissionRule[] {
  const slots = rulesBySource(context, kind)
  return RULE_SOURCES.flatMap(source =>
    (slots[source] ?? []).map(text => ({
      source,
      ruleBehavior: kind,
      ruleValue: permissionRuleValueFromString(text),
    })),
  )
}

export function getAllowRules(
  context: ToolPermissionContext,
): PermissionRule[] {
  return listRules(context, 'allow')
}

export function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return listRules(context, 'deny')
}

export function getAskRules(context: ToolPermissionContext): PermissionRule[] {
  return listRules(context, 'ask')
}

/**
 * An MCP rule names a server (`mcp__srv`, `mcp__srv__*`) or one tool by its
 * full name. Both sides go through the same `mcp__` parser, so a server name
 * holding `__` is read as the part before it on both sides alike.
 */
function namesServerOf(ruleToolName: string, permissionName: string): boolean {
  const ruled = mcpInfoFromString(ruleToolName)
  const target = mcpInfoFromString(permissionName)
  if (ruled === null || target === null) return false
  const wholeServer = ruled.toolName === undefined || ruled.toolName === '*'
  return wholeServer && ruled.serverName === target.serverName
}

function coversWholeTool(rule: PermissionRule, tool: RuleTarget): boolean {
  if (rule.ruleValue.ruleContent) return false
  // MCP tools answer to their full name only, never to a borrowed display name.
  const permissionName = getToolNameForPermissionCheck(tool)
  return (
    rule.ruleValue.toolName === permissionName ||
    namesServerOf(rule.ruleValue.toolName, permissionName)
  )
}

function firstWholeToolRule(
  context: ToolPermissionContext,
  kind: PermissionBehavior,
  tool: RuleTarget,
): PermissionRule | null {
  return listRules(context, kind).find(rule => coversWholeTool(rule, tool)) ?? null
}

export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return firstWholeToolRule(context, 'allow', tool)
}

export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return firstWholeToolRule(context, 'deny', tool)
}

export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return firstWholeToolRule(context, 'ask', tool)
}

export function getDenyRuleForAgent(
  context: ToolPermissionContext,
  agentToolName: string,
  agentType: string,
): PermissionRule | null {
  return (
    getDenyRules(context).find(
      ({ ruleValue }) =>
        ruleValue.toolName === agentToolName &&
        ruleValue.ruleContent === agentType,
    ) ?? null
  )
}

export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  const deniedTypes = new Set(
    getRuleByContentsForToolName(context, agentToolName, 'deny').keys(),
  )
  return agents.filter(agent => !deniedTypes.has(agent.agentType))
}

export function getRuleByContentsForTool(
  context: ToolPermissionContext,
  tool: Tool,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  return getRuleByContentsForToolName(
    context,
    getToolNameForPermissionCheck(tool),
    behavior,
  )
}

/** Later sources overwrite earlier ones for the same content, keeping its first position. */
export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  const byContent = new Map<string, PermissionRule>()
  for (const rule of listRules(context, behavior)) {
    const content = rule.ruleValue.ruleContent
    if (rule.ruleValue.toolName === toolName && content !== undefined) {
      byContent.set(content, rule)
    }
  }
  return byContent
}
