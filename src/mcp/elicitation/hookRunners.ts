import type {
  ElicitRequestParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  executeElicitationHooks,
  executeElicitationResultHooks,
  executeNotificationHooks,
} from 'src/platform/lifecycleHooks/hooks.js'
import { logMCPError } from 'src/shared/log.js'
import { modeOf, urlElicitationIdOf } from 'src/mcp/elicitation/queue.js'

type HookAnswer = ElicitResult | undefined

const DECLINED: ElicitResult = { action: 'decline' }

/** A decline never carries content, whoever gave it. */
export function hookAnswer(answer: ElicitResult): ElicitResult {
  return answer.action === 'decline'
    ? { ...DECLINED }
    : { action: answer.action, content: answer.content }
}

/** Fire and forget: the Notification hooks never hold up an answer. */
function announce(
  serverName: string,
  notificationType: string,
  message: string,
): void {
  executeNotificationHooks({ notificationType, message }).catch(error =>
    logMCPError(serverName, error),
  )
}

export function announceCompletion(
  serverName: string,
  elicitationId: string,
): void {
  announce(
    serverName,
    'elicitation_complete',
    `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
  )
}

/** The Elicitation hooks' answer to a request, or `undefined` to ask the user. */
export async function runElicitationHooks(
  serverName: string,
  params: ElicitRequestParams,
  signal: AbortSignal,
): Promise<HookAnswer> {
  try {
    const outcome = await executeElicitationHooks({
      serverName,
      message: params.message,
      requestedSchema:
        'requestedSchema' in params ? params.requestedSchema : undefined,
      signal,
      mode: modeOf(params),
      url: params.mode === 'url' ? params.url : undefined,
      elicitationId: urlElicitationIdOf(params),
    })
    if (outcome.blockingError) return { ...DECLINED }
    return outcome.elicitationResponse && hookAnswer(outcome.elicitationResponse)
  } catch (error) {
    logMCPError(serverName, error)
    return undefined
  }
}

async function applyResultHooks(
  serverName: string,
  result: ElicitResult,
  signal: AbortSignal,
  mode: 'form' | 'url' | undefined,
  elicitationId: string | undefined,
): Promise<ElicitResult> {
  try {
    const outcome = await executeElicitationResultHooks({
      serverName,
      action: result.action,
      content: result.content,
      signal,
      mode,
      elicitationId,
    })
    if (outcome.blockingError) return { ...DECLINED }
    const override = outcome.elicitationResultResponse
    if (!override) return result
    const answer = hookAnswer(override)
    return answer.action === 'decline'
      ? answer
      : { ...answer, content: answer.content ?? result.content }
  } catch (error) {
    logMCPError(serverName, error)
    return result
  }
}

/** The ElicitationResult hooks may change the user's answer; the final action is announced. */
export async function runElicitationResultHooks(
  serverName: string,
  result: ElicitResult,
  signal: AbortSignal,
  mode?: 'form' | 'url',
  elicitationId?: string,
): Promise<ElicitResult> {
  const final = await applyResultHooks(
    serverName,
    result,
    signal,
    mode,
    elicitationId,
  )
  announce(
    serverName,
    'elicitation_response',
    `Elicitation response for server "${serverName}": ${final.action}`,
  )
  return final
}
