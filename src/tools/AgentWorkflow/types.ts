/**
 * Agent-workflow types (AGENT_WORKFLOWS feature).
 *
 * A workflow is a linear state-machine of phases. Each phase runs 1+ worker
 * agents (in parallel when >1); a single `main` orchestrator agent synthesizes
 * their output and emits a structured decision (advance / refine / handback)
 * that drives the flow. Pure schemas only — no fs, no ink.
 */
import { z } from 'zod/v4'

/** Hard caps that bound a runaway refine/handback loop. */
export const MAX_TRANSITIONS = 20
export const MAX_REFINES_PER_STEP = 3

/** The structured decision the main orchestrator returns each phase. */
export const StepDecisionSchema = z.object({
  decision: z.enum(['advance', 'refine', 'handback']),
  /** Only meaningful for `handback`; must be one of the phase's `handbackTo`. */
  target: z.string().optional(),
  notes: z.string().default(''),
})
export type StepDecision = z.infer<typeof StepDecisionSchema>

/** One phase of a workflow. A phase with no agents is terminal (e.g. `done`). */
export const WorkflowStepSchema = z.object({
  name: z.string().min(1),
  agents: z.array(z.string().min(1)).default([]),
  handbackTo: z.array(z.string().min(1)).optional(),
})
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

/** A workflow definition, parsed from `.claudin/workflows/<name>.md`. */
export const WorkflowDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  /** Orchestrator agentType; when omitted the built-in `workflow-orchestrator` is used. */
  main: z.string().optional(),
  steps: z.array(WorkflowStepSchema).min(1),
  /** Markdown body — free-form instructions handed to main + workers. */
  instructions: z.string().default(''),
  /**
   * Basename of the `.md` this def was loaded from (e.g. `dev-flow.md`). Not
   * part of the frontmatter — set by the loader so delete/edit target the real
   * file even when the frontmatter `name` differs from the filename.
   */
  sourceFile: z.string().optional(),
})
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>

/** Per-agent execution stats surfaced on the board (mirrors the screenshot). */
export const AgentRunSchema = z.object({
  label: z.string(),
  model: z.string().default(''),
  tokens: z.number().default(0),
  tools: z.number().default(0),
  ms: z.number().default(0),
  /** Full worker output (resume-ready; may be capped when fed to main). */
  output: z.string().default(''),
  failed: z.boolean().default(false),
})
export type AgentRun = z.infer<typeof AgentRunSchema>

/** One executed phase, appended to the run history. */
export const PhaseRecordSchema = z.object({
  step: z.string(),
  stepIndex: z.number(),
  agents: z.array(AgentRunSchema).default([]),
  /** Main's synthesis text for this phase. */
  synthesis: z.string().default(''),
  /** Main's decision; null while the phase is still executing. */
  decision: StepDecisionSchema.nullable().default(null),
  at: z.number(),
})
export type PhaseRecord = z.infer<typeof PhaseRecordSchema>

export const RunStatusSchema = z.enum([
  'running',
  'done',
  'stalled',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

/** Persisted state of a single workflow run (`.claudin/workflows/.runs/<runId>.json`). */
export const RunStateSchema = z.object({
  runId: z.string(),
  workflow: z.string(),
  /** Workflow description (from the def), copied in at creation for the footer. */
  description: z.string().default(''),
  task: z.string(),
  currentStep: z.string(),
  status: RunStatusSchema,
  /** Accumulated artifact (the main's latest synthesis). */
  artifact: z.string().default(''),
  history: z.array(PhaseRecordSchema).default([]),
  transitions: z.number().default(0),
  refineCounts: z.record(z.string(), z.number()).default({}),
  totalTokens: z.number().default(0),
  /** Live worker progress for the current phase (surfaced in the REPL footer). */
  agentsInPhase: z.number().default(0),
  agentsDone: z.number().default(0),
  startedAt: z.number(),
  updatedAt: z.number(),
})
export type RunState = z.infer<typeof RunStateSchema>

/**
 * JSON Schema for the main's structured decision on a given phase. The
 * `handback` option (and `target` enum) is only offered when the phase declares
 * `handbackTo` — so the model can never hand back to an undeclared target.
 */
export function buildDecisionSchema(step: WorkflowStep): Record<string, unknown> {
  const handback = step.handbackTo ?? []
  const decisions =
    handback.length > 0 ? ['advance', 'refine', 'handback'] : ['advance', 'refine']

  const properties: Record<string, unknown> = {
    decision: {
      type: 'string',
      enum: decisions,
      description:
        'advance = move to the next phase; refine = re-run this phase; handback = return to an earlier phase (requires target).',
    },
    notes: {
      type: 'string',
      description:
        'Short rationale for the decision (shown on the board so the user understands why the flow advanced/looped).',
    },
  }
  if (handback.length > 0) {
    properties.target = {
      type: 'string',
      enum: handback,
      description: 'The phase to hand back to. Required only when decision is "handback".',
    }
  }

  return {
    type: 'object',
    properties,
    required: ['decision', 'notes'],
    additionalProperties: false,
  }
}

/** A phase with no agents is terminal (e.g. a trailing `done` phase). */
export function isTerminalStep(step: WorkflowStep | undefined): boolean {
  return !step || step.agents.length === 0
}
