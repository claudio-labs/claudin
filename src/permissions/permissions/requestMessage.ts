/**
 * The text a permission prompt shows, and the `PermissionRequest` hooks that
 * stand in for the prompt in a session that cannot show one.
 */
import { feature } from 'bun:bundle'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { extractOutputRedirections } from 'src/platform/bash/commands.js'
import { logError } from 'src/shared/log.js'
import { plural } from 'src/shared/text/stringUtils.js'
import type { PermissionRequestResult } from 'src/shared/types/hooks.js'
import { permissionModeTitle } from 'src/permissions/PermissionMode.js'
import type {
  PermissionAllowDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from 'src/permissions/PermissionResult.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js'
import { executePermissionRequestHooks } from 'src/platform/lifecycleHooks/hooks.js'
import { permissionRuleSourceDisplayString } from 'src/permissions/permissions/ruleLookup.js'

const PERMISSION_REQUEST_HOOK = 'PermissionRequest'

function notYetGranted(toolName: string): string {
  return `Claudin requested permissions to use ${toolName}, but you haven't granted it yet.`
}

function needsApprovalFrom(who: string, toolName: string): string {
  return `${who} requires approval for this ${toolName} command`
}

function stillToApprove(result: PermissionResult): boolean {
  return result.behavior === 'ask' || result.behavior === 'passthrough'
}

/** Bash parts lose their output redirections, so the list names the commands themselves. */
function shownPart(toolName: string, part: string): string {
  if (toolName !== BASH_TOOL_NAME) return part
  const { redirections, commandWithoutRedirections } = extractOutputRedirections(part)
  // The extractor re-serialises what it parses, so a part with nothing to cut keeps its own quoting.
  return redirections.length > 0 ? commandWithoutRedirections.trim() : part
}

function compoundCommandMessage(
  toolName: string,
  parts: Map<string, PermissionResult>,
): string {
  const pending = [...parts]
    .filter(([, result]) => stillToApprove(result))
    .map(([part]) => shownPart(toolName, part))
  const opening = `This ${toolName} command contains multiple operations`
  if (pending.length === 0) return `${opening} that require approval`
  const subject = `The following ${plural(pending.length, 'part')}`
  const verb = pending.length === 1 ? 'requires' : 'require'
  return `${opening}. ${subject} ${verb} approval: ${pending.join(', ')}`
}

export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  if (!decisionReason) return notYetGranted(toolName)
  switch (decisionReason.type) {
    case 'hook': {
      const hook = `Hook '${decisionReason.hookName}'`
      return decisionReason.reason
        ? `${hook} blocked this action: ${decisionReason.reason}`
        : needsApprovalFrom(hook, toolName)
    }
    case 'rule': {
      const { rule } = decisionReason
      const ruleText = permissionRuleValueToString(rule.ruleValue)
      const where = permissionRuleSourceDisplayString(rule.source)
      return needsApprovalFrom(`Permission rule '${ruleText}' from ${where}`, toolName)
    }
    case 'subcommandResults':
      return compoundCommandMessage(toolName, decisionReason.reasons)
    case 'permissionPromptTool':
      return needsApprovalFrom(`Tool '${decisionReason.permissionPromptToolName}'`, toolName)
    case 'sandboxOverride':
      return 'Run outside of the sandbox'
    case 'mode':
      return needsApprovalFrom(
        `Current permission mode (${permissionModeTitle(decisionReason.mode)})`,
        toolName,
      )
    case 'classifier':
      return feature('TRANSCRIPT_CLASSIFIER')
        ? `${needsApprovalFrom(`Classifier '${decisionReason.classifier}'`, toolName)}: ${decisionReason.reason}`
        : notYetGranted(toolName)
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
    case 'asyncAgent':
      return decisionReason.reason
  }
}

function grantedByHook(
  verdict: Extract<PermissionRequestResult, { behavior: 'allow' }>,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): PermissionAllowDecision {
  const updates = verdict.updatedPermissions ?? []
  if (updates.length > 0) {
    persistPermissionUpdates(updates)
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdates(prev.toolPermissionContext, updates),
    }))
  }
  return {
    behavior: 'allow',
    updatedInput: verdict.updatedInput ?? input,
    decisionReason: { type: 'hook', hookName: PERMISSION_REQUEST_HOOK },
  }
}

function refusedByHook(
  verdict: Extract<PermissionRequestResult, { behavior: 'deny' }>,
  tool: Tool,
  context: ToolUseContext,
): PermissionDenyDecision {
  if (verdict.interrupt) context.abortController.abort()
  return {
    behavior: 'deny',
    message: verdict.message || `Using ${tool.name} was denied by hook ${PERMISSION_REQUEST_HOOK}.`,
    decisionReason: {
      type: 'hook',
      hookName: PERMISSION_REQUEST_HOOK,
      ...(verdict.message ? { reason: verdict.message } : {}),
    },
  }
}

/**
 * The first hook that allows or denies settles the call. Null when none
 * decides, or when the hook runner itself fails.
 */
export async function runPermissionRequestHooksForHeadlessAgent(
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseID: string,
  context: ToolUseContext,
  permissionMode: string | undefined,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | null> {
  try {
    const events = executePermissionRequestHooks(
      tool.name,
      toolUseID,
      input,
      context,
      permissionMode,
      suggestions,
      context.abortController.signal,
    )
    for await (const event of events) {
      const verdict = event.permissionRequestResult
      if (verdict?.behavior === 'allow') return grantedByHook(verdict, input, context)
      if (verdict?.behavior === 'deny') return refusedByHook(verdict, tool, context)
    }
  } catch (error) {
    logError(error)
  }
  return null
}

export function getUpdatedInputOrFallback(
  permissionResult: PermissionResult,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const rewritten =
    permissionResult.behavior === 'allow' || permissionResult.behavior === 'ask'
      ? permissionResult.updatedInput
      : undefined
  return rewritten ?? fallback
}
