/**
 * Pure transition reducer for agent workflows.
 *
 * Given the current run state and the main orchestrator's decision, computes
 * the next state (advance / refine / handback) and enforces the runaway caps.
 * No I/O — fully unit-testable without ink/runAgent.
 */
import {
  isTerminalStep,
  MAX_REFINES_PER_STEP,
  MAX_TRANSITIONS,
  type RunState,
  type RunStatus,
  type StepDecision,
  type WorkflowDef,
} from 'src/tools/AgentWorkflow/types.js'

/**
 * Apply the main's decision for the phase the run is currently on. Returns a
 * new `RunState` (never mutates the input). The phase that just executed is
 * `state.currentStep`.
 */
export function applyDecision(
  state: RunState,
  decision: StepDecision,
  def: WorkflowDef,
): RunState {
  const steps = def.steps
  const idx = steps.findIndex(s => s.name === state.currentStep)
  const refineCounts = { ...state.refineCounts }
  const transitions = state.transitions + 1

  let currentStep = state.currentStep
  let status: RunStatus = 'running'

  if (decision.decision === 'advance') {
    const nextStep = steps[idx + 1]
    if (isTerminalStep(nextStep)) {
      status = 'done'
      if (nextStep) currentStep = nextStep.name
    } else {
      currentStep = nextStep.name
    }
  } else if (decision.decision === 'refine') {
    refineCounts[currentStep] = (refineCounts[currentStep] ?? 0) + 1
    if (refineCounts[currentStep] > MAX_REFINES_PER_STEP) status = 'stalled'
  } else {
    // handback
    const allowed = steps[idx]?.handbackTo ?? []
    if (!decision.target || !allowed.includes(decision.target)) {
      // Schema constrains this, but a hand-authored/edited run could disagree.
      status = 'stalled'
    } else {
      refineCounts[decision.target] = (refineCounts[decision.target] ?? 0) + 1
      if (refineCounts[decision.target] > MAX_REFINES_PER_STEP) status = 'stalled'
      else currentStep = decision.target
    }
  }

  // Global transition cap — never override a terminal `done`.
  if (status === 'running' && transitions >= MAX_TRANSITIONS) status = 'stalled'

  return {
    ...state,
    currentStep,
    status,
    refineCounts,
    transitions,
    updatedAt: Date.now(),
  }
}
