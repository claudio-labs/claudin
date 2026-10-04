/**
 * The order shift+tab walks the permission modes in.
 */
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { logForDebugging } from 'src/shared/debug.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import {
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
  transitionPermissionMode,
} from 'src/permissions/permissionSetup.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'

/** Auto is a stop only when built in, offered by the context, and open right now. */
function canCycleToAuto(ctx: ToolPermissionContext): boolean {
  if (autoModeStateModule === null || ctx.isAutoModeAvailable !== true) return false
  if (isAutoModeGateEnabled()) return true
  logForDebugging(`[auto-mode] shift+tab passes over auto: ${getAutoModeUnavailableReason()}`)
  return false
}

function autoElseDefault(ctx: ToolPermissionContext): PermissionMode {
  return canCycleToAuto(ctx) ? 'auto' : 'default'
}

/** The stop after each mode; a mode missing here goes back to `default`. */
const STOP_AFTER: Partial<Record<PermissionMode, (ctx: ToolPermissionContext) => PermissionMode>> = {
  default: () => 'acceptEdits',
  acceptEdits: () => 'plan',
  plan: ctx => (ctx.isBypassPermissionsModeAvailable ? 'bypassPermissions' : autoElseDefault(ctx)),
  bypassPermissions: autoElseDefault,
}

export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
  _teamContext?: { leadAgentId: string },
): PermissionMode {
  const step = STOP_AFTER[toolPermissionContext.mode]
  return step ? step(toolPermissionContext) : 'default'
}

export function cyclePermissionMode(
  toolPermissionContext: ToolPermissionContext,
  teamContext?: { leadAgentId: string },
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(toolPermissionContext, teamContext)
  return {
    nextMode,
    context: transitionPermissionMode(toolPermissionContext.mode, nextMode, toolPermissionContext),
  }
}
