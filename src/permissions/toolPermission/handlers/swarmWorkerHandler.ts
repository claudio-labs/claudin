import type { PendingClassifierCheck } from 'src/shared/types/permissions.js'
import { isAgentSwarmsEnabled } from 'src/agent/coordinator/agentSwarmsEnabled.js'
import { toError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import {
  createPermissionRequest,
  isSwarmWorker,
  sendPermissionRequestViaMailbox,
  type SwarmPermissionRequest,
} from 'src/agent/coordinator/swarm/permissionSync.js'
import {
  registerPermissionCallback,
  unregisterPermissionCallback,
} from 'src/agent/coordinator/hooks/useSwarmPermissionPoller.js'
import type { PermissionContext } from 'src/permissions/toolPermission/PermissionContext.js'
import { createResolveOnce } from 'src/permissions/toolPermission/PermissionContext.js'
import type { RemoteAnswer } from 'src/permissions/toolPermission/remoteAnswer.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

type SwarmWorkerPermissionParams = {
  ctx: PermissionContext
  description: string
  pendingClassifierCheck?: PendingClassifierCheck | undefined
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
}

type WaitingOn = { toolName: string; toolUseId: string; description: string } | null

/**
 * A worker in an agent team asks its leader instead of its own user. Null
 * hands the call back to the worker's own dialog: not a worker, or the
 * request could not be built or delivered.
 */
async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null> {
  if (!isAgentSwarmsEnabled() || !isSwarmWorker()) return null
  const { ctx } = params
  const classified = await ctx.tryClassifier?.(params.pendingClassifierCheck, params.updatedInput)
  if (classified) return classified
  const request = buildRequest(params)
  return request ? askLeader(ctx, request) : null
}

function buildRequest(params: SwarmWorkerPermissionParams): SwarmPermissionRequest | null {
  try {
    return createPermissionRequest({
      toolName: params.ctx.tool.name,
      toolUseId: params.ctx.toolUseID,
      input: params.ctx.input,
      description: params.description,
      permissionSuggestions: params.suggestions,
    })
  } catch (error) {
    logError(toError(error))
    return null
  }
}

function showWaiting(toolUseContext: ToolUseContext, waitingOn: WaitingOn): void {
  toolUseContext.setAppState(state => ({ ...state, pendingWorkerRequest: waitingOn }))
}

/** The leader's input counts only when it says something; `{}` means the call as made. */
function inputFromLeader(ctx: PermissionContext, given: Record<string, unknown> | undefined): Record<string, unknown> {
  return given && Object.keys(given).length > 0 ? given : ctx.input
}

async function decide(ctx: PermissionContext, answer: RemoteAnswer): Promise<PermissionDecision> {
  if (answer.behavior === 'allow') {
    return ctx.handleUserAllow(inputFromLeader(ctx, answer.updatedInput), answer.updatedPermissions)
  }
  ctx.logDecision({ decision: 'reject', source: { type: 'user_reject', hasFeedback: Boolean(answer.message) } })
  return ctx.cancelAndAbort(answer.message)
}

function askLeader(ctx: PermissionContext, request: SwarmPermissionRequest): Promise<PermissionDecision | null> {
  const { toolUseContext } = ctx
  const signal = toolUseContext.abortController.signal
  return new Promise(resolve => {
    const once = createResolveOnce<PermissionDecision | null>(decision => {
      signal.removeEventListener('abort', onAbort)
      showWaiting(toolUseContext, null)
      resolve(decision)
    })
    // Every way out but the leader's own answer must also stop listening for it.
    const giveUp = (decision: PermissionDecision | null): void => {
      if (!once.claim()) return
      unregisterPermissionCallback(request.id)
      once.resolve(decision)
    }
    const onAbort = (): void => giveUp(ctx.cancelAndAbort(undefined, true))
    const answered = (answer: RemoteAnswer): void => {
      if (!once.claim()) return
      decide(ctx, answer).then(once.resolve, (error: unknown) => {
        logError(toError(error))
        once.resolve(ctx.cancelAndAbort(undefined, true))
      })
    }

    registerPermissionCallback({
      requestId: request.id,
      toolUseId: ctx.toolUseID,
      onAllow: (updatedInput, updatedPermissions) => answered({ behavior: 'allow', updatedInput, updatedPermissions }),
      onReject: feedback => answered({ behavior: 'deny', message: feedback }),
    })
    showWaiting(toolUseContext, { toolName: request.toolName, toolUseId: request.toolUseId, description: request.description })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    sendPermissionRequestViaMailbox(request).then(
      delivered => {
        if (!delivered) giveUp(null)
      },
      (error: unknown) => {
        logError(toError(error))
        giveUp(null)
      },
    )
  })
}

export { handleSwarmWorkerPermission }
export type { SwarmWorkerPermissionParams }
