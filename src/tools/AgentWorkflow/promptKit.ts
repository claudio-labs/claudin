/**
 * Pure prompt-assembly for agent workflows.
 *
 * `buildWorkerPrompt` seeds each phase worker; `buildMainContext` gives the main
 * orchestrator the FULL workflow state each turn (it is the controller with the
 * global view). Worker outputs are capped when fed to main so a large fan-out
 * can't blow up the main's context. Pure strings — no ink/runAgent, so tested
 * directly.
 */
import { isTerminalStep, type RunState, type WorkflowDef, type WorkflowStep } from 'src/tools/AgentWorkflow/types.js'

/** Max chars of each worker output injected into the main's context. */
export const MAX_WORKER_OUTPUT_CHARS = 4000
/** Max chars of the running artifact injected into a worker prompt. */
export const MAX_ARTIFACT_CHARS = 6000

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

/**
 * Prompt for a single worker agent. The worker's *focus* is its own agent
 * definition (`agents: [...]` are distinct agents), so this prompt only carries
 * the shared context — the workflow instructions, the task, the current phase,
 * and the accumulated artifact.
 */
export function buildWorkerPrompt(
  def: WorkflowDef,
  task: string,
  artifact: string,
  step: WorkflowStep,
): string {
  const parts: string[] = []
  parts.push(`You are a worker agent in the "${def.name}" workflow, phase "${step.name}".`)
  if (def.instructions.trim()) {
    parts.push(`Workflow instructions:\n${def.instructions.trim()}`)
  }
  parts.push(`Task:\n${task}`)
  if (artifact.trim()) {
    parts.push(`Work so far (accumulated artifact from earlier phases):\n${truncate(artifact.trim(), MAX_ARTIFACT_CHARS)}`)
  }
  parts.push(
    'Do your part of this phase and report your findings/output. Another agent (the orchestrator) will synthesize the phase and decide what happens next — you do not decide the flow.',
  )
  return parts.join('\n\n')
}

/**
 * Full workflow context for the main orchestrator. Includes the task, the phase
 * list with status, the entire history (each phase's synthesis, decision and
 * per-worker output — capped), the current phase's fresh worker outputs, and the
 * handback targets available from the current phase. Ends by instructing the
 * main to emit a StructuredOutput decision.
 */
export function buildMainContext(state: RunState, def: WorkflowDef): string {
  const parts: string[] = []
  parts.push(`You are the orchestrator (main) of the "${def.name}" workflow. You control the flow.`)
  if (def.instructions.trim()) {
    parts.push(`Workflow instructions:\n${def.instructions.trim()}`)
  }
  parts.push(`Task:\n${state.task}`)

  // Phase list with status relative to the current phase.
  const currentIdx = def.steps.findIndex(s => s.name === state.currentStep)
  const phaseList = def.steps
    .map((s, i) => {
      const marker =
        i < currentIdx ? '[done]' : i === currentIdx ? '[current]' : '[pending]'
      const terminal = isTerminalStep(s) ? ' (terminal)' : ''
      return `  ${i + 1}. ${s.name} ${marker}${terminal}`
    })
    .join('\n')
  parts.push(`Phases:\n${phaseList}`)

  // Full history — every executed phase, capped per worker.
  if (state.history.length > 0) {
    const historyText = state.history
      .map(rec => {
        const workers = rec.agents
          .map(a => {
            const status = a.failed ? ' (FAILED)' : ''
            return `    • ${a.label}${status}:\n${truncate(a.output, MAX_WORKER_OUTPUT_CHARS)
              .split('\n')
              .map(l => `      ${l}`)
              .join('\n')}`
          })
          .join('\n')
        const decision = rec.decision
          ? `    decision: ${rec.decision.decision}${rec.decision.target ? ` → ${rec.decision.target}` : ''} — ${rec.decision.notes}`
          : '    decision: (pending — this is the phase you are deciding now)'
        return `  Phase "${rec.step}":\n${workers}\n${rec.synthesis ? `    synthesis: ${truncate(rec.synthesis, MAX_WORKER_OUTPUT_CHARS)}\n` : ''}${decision}`
      })
      .join('\n\n')
    parts.push(`History (all phases so far):\n${historyText}`)
  }

  // Available handback targets from the current phase.
  const currentStep = def.steps[currentIdx]
  const handback = currentStep?.handbackTo ?? []
  parts.push(
    handback.length > 0
      ? `From the current phase you may hand back to: ${handback.join(', ')}.`
      : 'The current phase has no handback targets; you may only advance or refine.',
  )

  parts.push(
    'Synthesize the current phase\'s worker outputs into an updated artifact (your final text), then call the StructuredOutput tool with your decision: advance (next phase), refine (re-run this phase), or handback (return to an allowed earlier phase). Include a short `notes` explaining why.',
  )
  return parts.join('\n\n')
}
