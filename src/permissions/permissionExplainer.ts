/**
 * The ctrl+e explanation of a shell command in a permission dialog.
 *
 * The answer is advice for the reader only: nothing here feeds the permission
 * decision, its suggested rules or the options the dialog offers.
 */
import type { Message } from 'src/shared/types/message.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import { getMainLoopModel } from 'src/providers/model/model.js'
import { sideQuery } from 'src/agent/sideQuery.js'
import { buildExplainTool, EXPLAIN_TOOL_NAME, parseExplanationReply } from 'src/permissions/explainer/answer.js'
import { buildExplainerPrompt } from 'src/permissions/explainer/prompt.js'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export type PermissionExplanation = {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

type GenerateExplanationParams = {
  toolName: string
  toolInput: unknown
  toolDescription?: string
  messages?: Message[]
  signal: AbortSignal
}

const EXPLAINER_SYSTEM_PROMPT =
  'You explain shell commands to the user: what they do, why you are running them, and the risk each one carries.'

/** On unless the user switched it off; an unset key counts as on. */
export function isPermissionExplainerEnabled(): boolean {
  return getGlobalConfig().permissionExplainerEnabled !== false
}

/**
 * Asks the session's main-loop model, the one the user picked, so the question
 * goes to no provider the session has not already used. Resolves to null when
 * switched off, when the answer is unusable, or when the call fails; it never
 * rejects.
 */
export async function generatePermissionExplanation({
  toolName,
  toolInput,
  toolDescription,
  messages,
  signal,
}: GenerateExplanationParams): Promise<PermissionExplanation | null> {
  if (!isPermissionExplainerEnabled()) return null

  const tool = buildExplainTool()
  const startedAt = Date.now()
  try {
    const reply = await sideQuery({
      model: getMainLoopModel(),
      system: EXPLAINER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildExplainerPrompt({ toolName, toolInput, toolDescription, messages }) }],
      tools: [tool],
      tool_choice: { type: 'tool', name: EXPLAIN_TOOL_NAME },
      signal,
    })
    const explanation = parseExplanationReply(reply)
    logForDebugging(
      `permission explainer: ${Date.now() - startedAt}ms, stop=${reply.stop_reason}, ${explanation ? 'usable' : 'unusable'} answer`,
    )
    return explanation
  } catch (error) {
    // A dialog that went away is not a failure worth recording.
    if (!signal.aborted) logError(error)
    return null
  }
}
