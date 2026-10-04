/**
 * The permission gate. It takes the decision for a call, and when that
 * decision is to ask, it tries the routes that can answer in a fixed order:
 * the coordinator's automated checks, the swarm leader, a running Bash
 * classification, and last the user's dialog. The abort checks between the
 * steps live here and nowhere else.
 */
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import type { ToolPermissionContext, Tool as ToolType, ToolUseContext } from 'src/tools/Tool.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
} from 'src/shared/types/permissions.js'
import { clearClassifierChecking } from 'src/permissions/classifierApprovals.js'
import { AbortError, isSdkApiUserAbortError } from 'src/shared/errors.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { hasPermissionsToUseTool } from 'src/permissions/permissions.js'
import { routeCapabilities, type RouteCapabilities } from 'src/permissions/toolPermission/capabilities.js'
import { handleCoordinatorPermission } from 'src/permissions/toolPermission/handlers/coordinatorHandler.js'
import { handleInteractivePermission } from 'src/permissions/toolPermission/handlers/interactiveHandler.js'
import { handleSwarmWorkerPermission } from 'src/permissions/toolPermission/handlers/swarmWorkerHandler.js'
import {
  createPermissionContext,
  createPermissionQueueOps,
  type PermissionContext,
  type PermissionQueueOps,
} from 'src/permissions/toolPermission/PermissionContext.js'
import { allowByRunningClassification } from 'src/permissions/toolPermission/gate/runningClassification.js'
import { isAutoModeVerdict, rememberAutoModeAllow, reportAutoModeDenial } from 'src/permissions/toolPermission/gate/autoModeVerdicts.js'

type Input = Record<string, unknown>
type Resolve = (decision: PermissionDecision) => void

export type GateDeps = {
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  setToolPermissionContext: (context: ToolPermissionContext, options?: { preserveMode?: boolean }) => void
}

export type PermissionGate = (
  tool: ToolType,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision,
) => Promise<PermissionDecision>

type Gate = {
  built: RouteCapabilities
  queue: PermissionQueueOps
  setToolPermissionContext: GateDeps['setToolPermissionContext']
}

function isAbortError(error: unknown): boolean {
  return error instanceof AbortError || isSdkApiUserAbortError(error)
}

function describe(ctx: PermissionContext): Promise<string> {
  const { toolUseContext } = ctx
  return ctx.tool.description(ctx.input, {
    isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
    toolPermissionContext: toolUseContext.getAppState().toolPermissionContext,
    tools: toolUseContext.options.tools,
  })
}

function allow(gate: Gate, ctx: PermissionContext, decision: PermissionAllowDecision, resolve: Resolve): void {
  ctx.logDecision({ decision: 'accept', source: 'config' })
  const reason = decision.decisionReason
  if (gate.built.autoMode && isAutoModeVerdict(reason)) rememberAutoModeAllow(ctx, reason)
  resolve(ctx.buildAllow(decision.updatedInput ?? ctx.input, { decisionReason: reason }))
}

function deny(gate: Gate, ctx: PermissionContext, decision: PermissionDenyDecision, description: string, resolve: Resolve): void {
  ctx.logDecision({ decision: 'reject', source: 'config' })
  const reason = decision.decisionReason
  if (gate.built.autoMode && isAutoModeVerdict(reason)) reportAutoModeDenial(ctx, description, reason)
  resolve(decision)
}

async function ask(gate: Gate, ctx: PermissionContext, decision: PermissionAskDecision, description: string, resolve: Resolve): Promise<void> {
  const permissions = ctx.toolUseContext.getAppState().toolPermissionContext
  const checksFirst = Boolean(permissions.awaitAutomatedChecksBeforeDialog)
  const pending = decision.pendingClassifierCheck
  const shared = { ctx, pendingClassifierCheck: pending, updatedInput: decision.updatedInput, suggestions: decision.suggestions }

  if (checksFirst) {
    const settled = await handleCoordinatorPermission({ ...shared, permissionMode: permissions.mode })
    if (settled) return resolve(settled)
  }
  if (ctx.resolveIfAborted(resolve)) return

  const fromLeader = await handleSwarmWorkerPermission({ ...shared, description })
  if (fromLeader) return resolve(fromLeader)

  if (gate.built.bashClassifier && !checksFirst && ctx.tool.name === BASH_TOOL_NAME && pending) {
    const classified = await allowByRunningClassification(ctx, pending, decision.updatedInput)
    if (classified) return resolve(classified)
  }

  const bridgeCallbacks = gate.built.bridge ? ctx.toolUseContext.getAppState().replBridgePermissionCallbacks : undefined
  handleInteractivePermission({ ctx, description, result: decision, awaitAutomatedChecksBeforeDialog: checksFirst, bridgeCallbacks }, resolve)
}

async function route(gate: Gate, ctx: PermissionContext, forceDecision: PermissionDecision | undefined, resolve: Resolve): Promise<void> {
  try {
    if (ctx.resolveIfAborted(resolve)) return
    const decision =
      forceDecision ?? (await hasPermissionsToUseTool(ctx.tool, ctx.input, ctx.toolUseContext, ctx.assistantMessage, ctx.toolUseID))
    if (decision.behavior === 'allow') {
      if (ctx.resolveIfAborted(resolve)) return
      return allow(gate, ctx, decision, resolve)
    }
    const description = await describe(ctx)
    if (ctx.resolveIfAborted(resolve)) return
    if (decision.behavior === 'deny') return deny(gate, ctx, decision, description, resolve)
    await ask(gate, ctx, decision, description, resolve)
  } catch (error) {
    if (isAbortError(error)) logForDebugging('Permission check ended by an abort')
    else logError(error)
    resolve(ctx.cancelAndAbort(undefined, true))
  } finally {
    clearClassifierChecking(ctx.toolUseID)
  }
}

export function createPermissionGate(deps: GateDeps): PermissionGate {
  const gate: Gate = {
    built: routeCapabilities(),
    queue: createPermissionQueueOps(deps.setToolUseConfirmQueue),
    setToolPermissionContext: deps.setToolPermissionContext,
  }
  return (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) =>
    new Promise(resolve => {
      const ctx = createPermissionContext(tool, input, toolUseContext, assistantMessage, toolUseID, gate.setToolPermissionContext, gate.queue)
      void route(gate, ctx, forceDecision, resolve)
    })
}
