import { awaitClassifierAutoApproval } from 'src/tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { PendingClassifierCheck } from 'src/shared/types/permissions.js'
import { ruleOf, type PromptRuleReason } from 'src/permissions/toolPermission/promptRule.js'

export type ClassifierMatch = { reason: PromptRuleReason; rule: string }

/**
 * Asks the Bash prompt-rule classifier (or the classification already
 * running for the command) whether the call matches a described rule.
 * Only a Bash call with a pending check is ever classified, and anything
 * short of a confident match, a failure included, is no match.
 */
export async function classifyPendingBashCall(
  toolName: string,
  pending: PendingClassifierCheck | undefined,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<ClassifierMatch | null> {
  if (toolName !== BASH_TOOL_NAME || !pending) return null
  let reason
  try {
    reason = await awaitClassifierAutoApproval(pending, signal, isNonInteractiveSession)
  } catch (error) {
    logForDebugging(`Bash prompt-rule classifier failed: ${errorMessage(error)}`, { level: 'warn' })
    return null
  }
  if (reason?.type !== 'classifier') return null
  const rule = ruleOf(reason)
  return rule === undefined ? null : { reason, rule }
}
