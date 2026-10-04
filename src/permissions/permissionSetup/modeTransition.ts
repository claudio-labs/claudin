/**
 * The one place every permission-mode change goes through, so that CLI
 * shift+tab, SDK control messages and the plan tools all produce the same
 * side effects.
 */
import {
  handleAutoModeTransition,
  handlePlanModeTransition,
  setHasExitedPlanMode,
} from 'src/platform/bootstrap/state.js'
import { ClaudeError } from 'src/shared/errors.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { isAutoModeGateEnabled } from 'src/permissions/permissionSetup/autoModeAvailability.js'
import {
  autoModeBuiltIn,
  autoSemanticsActive,
  switchAutoOff,
  switchAutoOn,
} from 'src/permissions/permissionSetup/autoSession.js'
import { prepareContextForPlanMode } from 'src/permissions/permissionSetup/planAutoMode.js'

export class AutoModeGateClosedError extends ClaudeError {
  constructor() {
    super('Cannot transition to auto mode: gate is not enabled')
  }
}

/** A mode runs with auto when it is auto, or plan while auto is switched on. */
function runsWithAuto(mode: string): boolean {
  return mode === 'auto' || (mode === 'plan' && autoSemanticsActive())
}

function forgetPrePlanMode(context: ToolPermissionContext): ToolPermissionContext {
  if (context.prePlanMode === undefined) return context
  return { ...context, prePlanMode: undefined }
}

/**
 * Returns the context prepared for `toMode`. Never sets `mode`: the caller
 * does, once it has the result.
 */
export function transitionPermissionMode(
  fromMode: string,
  toMode: string,
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (fromMode === toMode) return context

  const autoInBuild = autoModeBuiltIn()
  const hadAuto = runsWithAuto(fromMode)
  const entersAuto = autoInBuild && toMode === 'auto' && !hadAuto
  // Refuse before any side effect, so a refused entry leaves the session as it was.
  if (entersAuto && !isAutoModeGateEnabled()) throw new AutoModeGateClosedError()

  handlePlanModeTransition(fromMode, toMode)
  handleAutoModeTransition(fromMode, toMode)
  const leavesPlan = fromMode === 'plan'
  if (leavesPlan) setHasExitedPlanMode(true)

  if (autoInBuild && toMode === 'plan') return prepareContextForPlanMode(context)

  let prepared = context
  if (entersAuto) prepared = switchAutoOn(prepared)
  else if (autoInBuild && hadAuto && toMode !== 'auto') prepared = switchAutoOff(prepared)
  return leavesPlan ? forgetPrePlanMode(prepared) : prepared
}
