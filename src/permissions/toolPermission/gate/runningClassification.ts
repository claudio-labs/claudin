/**
 * The gate's short wait on a Bash prompt-rule classification that is already
 * running for the command, so a call it matches never opens a dialog.
 */
import { consumeSpeculativeClassifierCheck, peekSpeculativeClassifierCheck } from 'src/tools/BashTool/bashPermissions.js'
import { setClassifierApproval } from 'src/permissions/classifierApprovals.js'
import type { ClassifierResult } from 'src/permissions/bashClassifier.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PendingClassifierCheck } from 'src/shared/types/permissions.js'
import type { PermissionContext } from 'src/permissions/toolPermission/PermissionContext.js'
import { isConfidentMatch, promptRuleReason } from 'src/permissions/toolPermission/promptRule.js'

const RUNNING_CHECK_WAIT_MS = 2_000

/** The classification's result, or null when it fails or takes longer than the wait. */
async function resultWithinWait(running: Promise<ClassifierResult>): Promise<ClassifierResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(resolve, RUNNING_CHECK_WAIT_MS, null)
  })
  const settled = running.catch((error: unknown) => {
    logForDebugging(`Running Bash prompt-rule classification failed: ${errorMessage(error)}`, { level: 'warn' })
    return null
  })
  try {
    return await Promise.race([settled, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Allows the call when the running classification matches a rule with high
 * confidence. Anything else leaves the classification running, for the
 * dialog to pick up instead of asking the model again.
 */
export async function allowByRunningClassification(
  ctx: PermissionContext,
  pending: PendingClassifierCheck,
  updatedInput: Record<string, unknown> | undefined,
): Promise<PermissionDecision | null> {
  const running = peekSpeculativeClassifierCheck(pending.command)
  if (!running) return null
  const result = await resultWithinWait(running)
  if (!result || !isConfidentMatch(result)) return null
  consumeSpeculativeClassifierCheck(pending.command)
  setClassifierApproval(ctx.toolUseID, result.matchedDescription)
  ctx.logDecision({ decision: 'accept', source: { type: 'classifier' } })
  return ctx.buildAllow(updatedInput ?? ctx.input, { decisionReason: promptRuleReason(result.matchedDescription) })
}
