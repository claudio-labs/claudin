import type { BridgePermissionCallbacks } from 'src/platform/bridge/bridgePermissionCallbacks.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { toError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { hasPermissionsToUseTool } from 'src/permissions/permissions.js'
import type { PermissionContext, ResolveOnce } from 'src/permissions/toolPermission/PermissionContext.js'
import { createResolveOnce } from 'src/permissions/toolPermission/PermissionContext.js'
import { routeCapabilities } from 'src/permissions/toolPermission/capabilities.js'
import { writesSettingsFile } from 'src/permissions/toolPermission/context/ruleUpdates.js'
import { startClassifierRace, type ClassifierRace } from 'src/permissions/toolPermission/dialog/classifierRace.js'
import { openRemotePrompt, type RemotePrompt } from 'src/permissions/toolPermission/dialog/remotePrompt.js'
import type { RemoteAnswer } from 'src/permissions/toolPermission/remoteAnswer.js'

type InteractivePermissionParams = {
  ctx: PermissionContext
  description: string
  result: PermissionDecision & { behavior: 'ask' }
  awaitAutomatedChecksBeforeDialog: boolean | undefined
  bridgeCallbacks?: BridgePermissionCallbacks
}

/** Everything that can answer the open dialog, and how each is told it lost. */
type Answerers = {
  ctx: PermissionContext
  once: ResolveOnce<PermissionDecision>
  remote: RemotePrompt | undefined
  race: ClassifierRace | undefined
}

/** Takes the dialog out of the race for whoever won and drops it from the queue. */
function closeForAutomatedAnswer(a: Answerers): void {
  a.race?.stop()
  a.remote?.withdraw()
  a.ctx.removeFromQueue()
}

function takeRemoteAnswer(a: Answerers, answer: RemoteAnswer, shownInput: Record<string, unknown>): void {
  if (!a.once.claim()) return
  const { ctx } = a
  a.race?.stop()
  a.remote?.close()
  ctx.removeFromQueue()
  if (answer.behavior === 'deny') {
    ctx.logDecision({ decision: 'reject', source: { type: 'user_reject', hasFeedback: Boolean(answer.message) } })
    a.once.resolve(ctx.cancelAndAbort(answer.message))
    return
  }
  // The save is not awaited: the web app already showed its answer as given.
  ctx.persistPermissions(answer.updatedPermissions).catch((error: unknown) => logError(toError(error)))
  ctx.logDecision({ decision: 'accept', source: { type: 'user', permanent: writesSettingsFile(answer.updatedPermissions) } })
  a.once.resolve(ctx.buildAllow(answer.updatedInput ?? shownInput))
}

function runHooksBehindDialog(a: Answerers, result: InteractivePermissionParams['result'], openedAt: number): void {
  const mode = a.ctx.toolUseContext.getAppState().toolPermissionContext.mode
  a.ctx.runHooks(mode, result.suggestions, result.updatedInput, openedAt).then(
    decision => {
      if (!decision || !a.once.claim()) return
      closeForAutomatedAnswer(a)
      a.once.resolve(decision)
    },
    (error: unknown) => logError(toError(error)),
  )
}

async function recheck(a: Answerers): Promise<void> {
  if (a.once.isResolved()) return
  const { ctx } = a
  const fresh = await hasPermissionsToUseTool(ctx.tool, ctx.input, ctx.toolUseContext, ctx.assistantMessage, ctx.toolUseID)
  if (fresh.behavior !== 'allow' || !a.once.claim()) return
  closeForAutomatedAnswer(a)
  ctx.logDecision({ decision: 'accept', source: 'config' })
  a.once.resolve(ctx.buildAllow(fresh.updatedInput ?? ctx.input))
}

/**
 * Opens the permission dialog and races everything else that can answer it:
 * the PermissionRequest hooks, the web app, the Bash prompt-rule classifier
 * and a re-check after the rules change. The first answer is the only one.
 */
function handleInteractivePermission(
  params: InteractivePermissionParams,
  resolve: (decision: PermissionDecision) => void,
): void {
  const { ctx, description, result } = params
  const built = routeCapabilities()
  const checksDone = Boolean(params.awaitAutomatedChecksBeforeDialog)
  const openedAt = Date.now()
  const shownInput = result.updatedInput ?? ctx.input
  const pending = result.pendingClassifierCheck
  const classifies = built.bashClassifier && !checksDone && ctx.tool.name === BASH_TOOL_NAME && pending !== undefined

  const a: Answerers = { ctx, once: createResolveOnce(resolve), remote: undefined, race: undefined }
  const signal = ctx.toolUseContext.abortController.signal

  ctx.pushToQueue({
    assistantMessage: ctx.assistantMessage,
    tool: ctx.tool,
    description,
    input: shownInput,
    toolUseContext: ctx.toolUseContext,
    toolUseID: ctx.toolUseID,
    permissionResult: result,
    permissionPromptStartTimeMs: openedAt,
    ...(built.bashClassifier ? { classifierCheckInProgress: classifies } : {}),
    onUserInteraction: () => a.race?.userInteracted(),
    onDismissCheckmark: () => a.race?.dismissCheckmark(),
    onAllow(input, updates, feedback, contentBlocks) {
      if (!a.once.claim()) return
      a.race?.stop()
      a.remote?.report({ behavior: 'allow', updatedInput: input, updatedPermissions: updates })
      ctx
        .handleUserAllow(input, updates, feedback, openedAt, contentBlocks, result.decisionReason)
        .then(a.once.resolve, (error: unknown) => {
          logError(toError(error))
          a.once.resolve(ctx.cancelAndAbort(undefined, true))
        })
    },
    onReject(feedback, contentBlocks) {
      if (!a.once.claim()) return
      a.race?.stop()
      a.remote?.report({ behavior: 'deny', message: feedback || 'User denied permission' })
      ctx.logDecision({ decision: 'reject', source: { type: 'user_reject', hasFeedback: Boolean(feedback) } }, { permissionPromptStartTimeMs: openedAt })
      a.once.resolve(ctx.cancelAndAbort(feedback, false, contentBlocks))
    },
    onAbort() {
      if (!a.once.claim()) return
      a.race?.stop()
      a.remote?.report({ behavior: 'deny', message: 'User aborted' })
      ctx.logDecision({ decision: 'reject', source: { type: 'user_abort' } }, { permissionPromptStartTimeMs: openedAt })
      a.once.resolve(ctx.cancelAndAbort(undefined, true))
    },
    recheckPermission: () => recheck(a),
  })

  if (!checksDone) runHooksBehindDialog(a, result, openedAt)

  if (params.bridgeCallbacks) {
    a.remote = openRemotePrompt(
      params.bridgeCallbacks,
      signal,
      {
        toolName: ctx.tool.name,
        input: shownInput,
        toolUseID: ctx.toolUseID,
        description,
        suggestions: result.suggestions,
        blockedPath: result.blockedPath,
      },
      answer => takeRemoteAnswer(a, answer, shownInput),
    )
  }

  if (classifies && pending) {
    a.race = startClassifierRace({
      ctx,
      pending,
      once: a.once,
      openedAt,
      showsCheckmark: built.autoMode,
      onApproved: () => a.remote?.withdraw(),
    })
  }
}

export { handleInteractivePermission }
export type { InteractivePermissionParams }
