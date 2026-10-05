/**
 * What an approving answer to the plan-exit dialog does, decided without
 * React and without reading any build flag: the flag, the gate and the
 * session's auto state come in as facts, read by the caller at the moment
 * the answer is given.
 */
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import type { PlanAnswer } from 'src/permissions/ui/modeDialogs/planExitChoices.js'

export type PlanExitFacts = {
  /** The build carries auto mode at all. */
  autoBuiltIn: boolean
  /** The auto-mode gate, checked now rather than when the dialog opened. */
  gateOpen: boolean
  /** Auto mode was running while the plan was made. */
  autoActive: boolean
}

export type ApprovingAnswer = Extract<PlanAnswer, { kind: 'keep' | 'clear' | 'manual' | 'plainExit' }>

export type PlanExitOutcome = {
  /** The mode the session works in after the plan. */
  mode: PermissionMode
  /**
   * `allow` approves the tool call and carries the mode in its updates;
   * `restart` turns the call down and hands the plan to the next turn, on a
   * cleared context.
   */
  route: 'allow' | 'restart'
  /**
   * `enterContext` switches the live context to auto now; `enterFlag` only
   * raises the session flag, because the next turn prepares its own context;
   * `leave` turns a running auto mode off and gives its rules back.
   */
  auto: 'enterContext' | 'enterFlag' | 'leave' | 'untouched'
  /** A plan-exit notice is queued for the model (not on a restart). */
  planExitNotice: boolean
  /** The session is named after the plan (not for the empty plan's Yes). */
  nameSession: boolean
}

function modeFor(answer: ApprovingAnswer, facts: PlanExitFacts): PermissionMode {
  if (answer.kind === 'manual' || answer.kind === 'plainExit') return 'default'
  switch (answer.elevation) {
    case 'bypass':
      return 'bypassPermissions'
    case 'edits':
      return 'acceptEdits'
    case 'auto':
      return facts.autoBuiltIn && facts.gateOpen ? 'auto' : 'default'
  }
}

function autoChange(mode: PermissionMode, restart: boolean, facts: PlanExitFacts): PlanExitOutcome['auto'] {
  if (mode === 'auto') return restart ? 'enterFlag' : 'enterContext'
  return facts.autoActive ? 'leave' : 'untouched'
}

export function planExitOutcome(answer: ApprovingAnswer, facts: PlanExitFacts): PlanExitOutcome {
  const mode = modeFor(answer, facts)
  const restart = answer.kind === 'clear'
  return {
    mode,
    route: restart ? 'restart' : 'allow',
    auto: autoChange(mode, restart, facts),
    planExitNotice: !restart,
    nameSession: answer.kind !== 'plainExit',
  }
}
