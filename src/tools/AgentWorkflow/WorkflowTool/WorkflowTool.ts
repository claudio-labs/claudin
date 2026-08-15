import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, isConfigReadingAllowed } from 'src/platform/config/config.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logError } from 'src/shared/log.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { enqueuePendingNotification } from 'src/agent/messageQueueManager.js'
import { getKnownAgentTypes } from 'src/tools/AgentWorkflow/agentTypes.js'
import { WORKFLOW_RUN_TOOL_NAME } from 'src/tools/AgentWorkflow/constants.js'
import {
  loadWorkflowDef,
  loadWorkflowDefs,
  validateWorkflowAgents,
  validateWorkflowStructure,
} from 'src/tools/AgentWorkflow/loadWorkflows.js'
import type { RunStatus } from 'src/tools/AgentWorkflow/types.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    workflow: z.string().describe('Name of the workflow to run (a .claudin/workflows/<name>.md).'),
    task: z.string().describe('The task/goal to seed the workflow with.'),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Run detached; returns a runId immediately and notifies on completion.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Output =
  | { kind: 'launched'; runId: string; status: string }
  | {
      kind: 'result'
      runId: string
      status: RunStatus
      artifact: string
      totalTokens: number
      phases: Array<{ step: string; decision: string | null }>
    }
  | { kind: 'error'; message: string; available?: string[] }

const outputSchema = lazySchema(() => z.custom<Output>())
type OutputSchema = ReturnType<typeof outputSchema>

const DESCRIPTION = `Run a Claudin agent workflow: a staged pipeline (backlog → dev → review → …) where each phase runs one or more agents and a main orchestrator synthesizes their work and decides whether to advance, refine, or hand back. Use ListWorkflows to discover available workflows and WorkflowStatus to inspect a run.`

const PROMPT = `Run a saved agent workflow by name against a task.

Use this ONLY when the user explicitly asks for a workflow / multi-phase orchestration, or names a saved workflow. Do NOT fire a workflow for ordinary tasks — it can spawn many agents and spend a lot of tokens; prefer a single Agent call otherwise.

- \`workflow\`: the workflow name (see ListWorkflows).
- \`task\`: what to accomplish.
- \`run_in_background: true\`: return immediately with a runId and get a notification when done (inspect progress with WorkflowStatus); omit to run synchronously and get the final result inline.`

export const WorkflowTool = buildTool({
  name: WORKFLOW_RUN_TOOL_NAME,
  searchHint: 'run a staged multi-agent workflow by name',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Workflow'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.workflow
  },
  renderToolUseMessage(input) {
    return `${input.workflow}: ${input.task}`
  },
  async call(input, toolUseContext, canUseTool) {
    const def = await loadWorkflowDef(input.workflow)
    if (!def) {
      const { defs } = await loadWorkflowDefs()
      return {
        data: {
          kind: 'error',
          message: `Workflow "${input.workflow}" not found.`,
          available: defs.map(d => d.name),
        } satisfies Output,
      }
    }

    const known = await getKnownAgentTypes(getCwd())
    const errors = [...validateWorkflowStructure(def), ...validateWorkflowAgents(def, known)]
    if (errors.length > 0) {
      return {
        data: { kind: 'error', message: `Workflow "${def.name}" is invalid:\n- ${errors.join('\n- ')}` } satisfies Output,
      }
    }

    const signal = toolUseContext.abortController?.signal

    // Import the engine lazily. A static import would pull engine.ts — and its
    // AgentTool ecosystem imports (runAgent/agentToolUtils) — into the tool
    // registry's eval graph (tools.ts eagerly loads the workflow tools), which
    // reorders module init and trips AgentTool's eager buildTool over an
    // uninitialized schema. The engine is only needed once a run actually fires.
    const { runWorkflow } = await import('src/tools/AgentWorkflow/engine.js')

    // The model's explicit choice wins; when it omits the param, fall back to the
    // persisted default (`/config` → "Workflows run in background"). Never detach
    // in headless -p — a backgrounded run there would orphan (getIsNonInteractiveSession).
    const wantsBackground =
      input.run_in_background ??
      (isConfigReadingAllowed() && getGlobalConfig().workflowsDefaultBackground === true)
    const runBackground = wantsBackground && !getIsNonInteractiveSession()
    if (runBackground) {
      let resolveRunId: (id: string | null) => void = () => {}
      const runIdPromise = new Promise<string | null>(r => {
        resolveRunId = r
      })
      let seen = false
      const settleRunId = (id: string | null) => {
        if (!seen) {
          seen = true
          resolveRunId(id)
        }
      }
      const runPromise = runWorkflow({
        def,
        task: input.task,
        toolUseContext,
        canUseTool,
        signal,
        onProgress: s => settleRunId(s.runId),
      })
      runPromise
        .then(final => {
          const result = (final.artifact || '').slice(0, 2000)
          enqueuePendingNotification({
            value: `<task-notification>\n<status>${final.status}</status>\n<summary>Workflow "${def.name}" ${final.status} (run ${final.runId})</summary>\n<result>${result}</result>\n</task-notification>`,
            mode: 'task-notification',
          })
        })
        .catch(error => {
          logError(error)
          // Ensure the awaited runId below never wedges if the run rejected
          // before its first onProgress (e.g. createRun I/O failure).
          settleRunId(null)
        })
      const runId = await runIdPromise
      if (runId === null) {
        return {
          data: {
            kind: 'error',
            message: `Workflow "${def.name}" failed to start (see logs).`,
          } satisfies Output,
        }
      }
      return { data: { kind: 'launched', runId, status: 'running' } satisfies Output }
    }

    const final = await runWorkflow({ def, task: input.task, toolUseContext, canUseTool, signal })
    return {
      data: {
        kind: 'result',
        runId: final.runId,
        status: final.status,
        artifact: final.artifact,
        totalTokens: final.totalTokens,
        phases: final.history.map(h => ({
          step: h.step,
          decision: h.decision ? `${h.decision.decision}${h.decision.target ? `→${h.decision.target}` : ''}` : null,
        })),
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as Output
    let text: string
    if (out.kind === 'error') {
      text = out.available
        ? `${out.message}\nAvailable workflows: ${out.available.join(', ') || '(none)'}`
        : out.message
    } else if (out.kind === 'launched') {
      text = `Workflow launched in background. runId=${out.runId}. Use WorkflowStatus to check progress.`
    } else {
      const phases = out.phases
        .map(p => `- ${p.step}${p.decision ? ` (${p.decision})` : ''}`)
        .join('\n')
      text = `Workflow run ${out.runId} finished: ${out.status} · ${out.totalTokens.toLocaleString()} tokens\nPhases:\n${phases}\n\n${out.artifact}`
    }
    return { tool_use_id: toolUseID, type: 'tool_result', content: text }
  },
} satisfies ToolDef<InputSchema, Output>)
