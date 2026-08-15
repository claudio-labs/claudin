/**
 * Workflow engine — drives a workflow's phases outside the model tool-loop.
 *
 * Per phase: fan out the phase's worker agents in parallel (capped), then invoke
 * the `main` orchestrator with the FULL run state to synthesize and emit a
 * structured advance/refine/handback decision (forced via StructuredOutput). The
 * pure reducer applies the decision; state is persisted after every step and
 * streamed to `onProgress`. Workers/main run with their agent-def permission
 * mode, clamped so they never exceed the session's permission context.
 */
import os from 'os'
import pMap from 'p-map'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { assembleToolPool } from 'src/tools.js'
import {
  type AgentDefinition,
  getAgentDefinitionsWithOverrides,
  isBuiltInAgent,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import { countToolUses } from 'src/tools/AgentTool/agentToolUtils.js'
import { runAgent } from 'src/tools/AgentTool/runAgent.js'
import { createSyntheticOutputTool } from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Tool, Tools, ToolUseContext } from 'src/Tool.js'
import { getCwd } from 'src/utils/fs/cwd.js'
import { isAbortError } from 'src/utils/errors.js'
import { logError } from 'src/utils/log.js'
import { createUserMessage } from 'src/services/messages/factories.js'
import { getQuerySourceForAgent } from 'src/utils/promptCategory.js'
import { getTokenCountFromUsage } from 'src/services/context/tokens.js'
import { WORKFLOW_ORCHESTRATOR_AGENT, WORKFLOW_ORCHESTRATOR_AGENT_TYPE } from 'src/tools/AgentWorkflow/orchestratorAgent.js'
import { clampMode } from 'src/tools/AgentWorkflow/permissionClamp.js'
import { buildMainContext, buildWorkerPrompt } from 'src/tools/AgentWorkflow/promptKit.js'
import { createRun, writeRun } from 'src/tools/AgentWorkflow/runStore.js'
import { applyDecision } from 'src/tools/AgentWorkflow/transitionReducer.js'
import {
  type AgentRun,
  type PhaseRecord,
  type RunState,
  StepDecisionSchema,
  type WorkflowDef,
  buildDecisionSchema,
  isTerminalStep,
} from 'src/tools/AgentWorkflow/types.js'

export type WorkflowProgress = (state: RunState) => void

/** Minimal structural view of the messages runAgent yields (the fork's message
 * type module isn't mirrored, so we read only the fields we need). */
type WfMessage = {
  type: string
  attachment?: { type?: string; data?: unknown }
  message?: {
    content?: Array<{ type: string; text?: string }>
    usage?: unknown
  }
}

function concurrencyCap(): number {
  return Math.max(1, Math.min(8, os.cpus().length - 1))
}

/** Reduce a driven agent's message stream into text + token/tool stats. */
function reduceAgentRun(messages: WfMessage[]): { text: string; tokens: number; tools: number } {
  let text = ''
  let tokens = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type !== 'assistant' || !m.message) continue
    if (!text) {
      const blocks = (m.message.content ?? []).filter(b => b.type === 'text' && b.text)
      if (blocks.length > 0) text = blocks.map(b => b.text ?? '').join('\n')
    }
    if (tokens === 0 && m.message.usage) {
      tokens = getTokenCountFromUsage(m.message.usage as Parameters<typeof getTokenCountFromUsage>[0])
    }
    if (text && tokens) break
  }
  const tools = countToolUses(messages as unknown as Parameters<typeof countToolUses>[0])
  return { text, tokens, tools }
}

/** Drive one agent to completion (foreground) and capture its output + stats. */
async function runOneAgent(opts: {
  label: string
  agentDef: AgentDefinition
  promptText: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  extraTools?: Tool[]
  runId: string
  abortController: AbortController
}): Promise<{ run: AgentRun; structuredOutput?: unknown }> {
  const { label, agentDef, promptText, toolUseContext, canUseTool, extraTools, runId } = opts
  const started = Date.now()
  const appState = toolUseContext.getAppState()
  const sessionMode = appState.toolPermissionContext.mode
  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: clampMode(agentDef.permissionMode, sessionMode),
  }
  let availableTools: Tools = assembleToolPool(workerPermissionContext, appState.mcp.tools)
  if (extraTools && extraTools.length > 0) availableTools = [...availableTools, ...extraTools]

  const modelLabel = agentDef.model ?? String(toolUseContext.options.mainLoopModel ?? '')

  const messages: WfMessage[] = []
  let structuredOutput: unknown
  let failed = false
  try {
    const gen = runAgent({
      agentDefinition: agentDef,
      promptMessages: [createUserMessage({ content: promptText })],
      toolUseContext,
      canUseTool,
      isAsync: false,
      querySource: getQuerySourceForAgent(agentDef.agentType, isBuiltInAgent(agentDef)),
      availableTools,
      transcriptSubdir: `workflows/${runId}`,
      description: `${label} (workflow)`,
      override: { abortController: opts.abortController },
    }) as AsyncGenerator<WfMessage, void>
    for await (const message of gen) {
      messages.push(message)
      if (message.type === 'attachment' && message.attachment?.type === 'structured_output') {
        structuredOutput = message.attachment.data
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    logError(error)
    failed = true
  }

  const { text, tokens, tools } = reduceAgentRun(messages)
  return {
    run: {
      label,
      model: modelLabel,
      tokens,
      tools,
      ms: Date.now() - started,
      output: failed ? '' : text,
      failed,
    },
    structuredOutput,
  }
}

/**
 * Run a workflow to completion (or `stalled`/`failed`/`cancelled`), persisting
 * and emitting `onProgress` after every phase and decision.
 */
export async function runWorkflow(params: {
  def: WorkflowDef
  task: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  onProgress?: WorkflowProgress
  signal?: AbortSignal
}): Promise<RunState> {
  const { def, task, toolUseContext, canUseTool, onProgress, signal } = params

  // Resolve agentType -> definition (project/global/built-in agents + the
  // built-in orchestrator used when the workflow declares no `main`).
  const { allAgents } = await getAgentDefinitionsWithOverrides(getCwd())
  const agentMap = new Map<string, AgentDefinition>(allAgents.map(a => [a.agentType, a]))
  agentMap.set(WORKFLOW_ORCHESTRATOR_AGENT_TYPE, WORKFLOW_ORCHESTRATOR_AGENT)
  const mainDef = agentMap.get(def.main ?? WORKFLOW_ORCHESTRATOR_AGENT_TYPE) ?? WORKFLOW_ORCHESTRATOR_AGENT

  const abortController = new AbortController()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', () => abortController.abort(), { once: true })
  }

  let state = await createRun({ workflow: def.name, description: def.description, task, firstStep: def.steps[0]!.name })
  onProgress?.(state)

  const persist = async (): Promise<void> => {
    await writeRun(state)
    onProgress?.(state)
  }

  while (state.status === 'running') {
    if (signal?.aborted) {
      state = { ...state, status: 'cancelled', updatedAt: Date.now() }
      await persist()
      break
    }

    const stepIndex = def.steps.findIndex(s => s.name === state.currentStep)
    const step = def.steps[stepIndex]
    if (isTerminalStep(step)) {
      state = { ...state, status: 'done', updatedAt: Date.now() }
      await persist()
      break
    }

    // (1) Fan out the phase's workers in parallel (capped), fail-open.
    // Reset the live per-worker progress so the footer shows 0/N for this phase.
    state = { ...state, agentsInPhase: step.agents.length, agentsDone: 0, updatedAt: Date.now() }
    await persist()
    let workerRuns: AgentRun[]
    try {
      const results = await pMap(
        step.agents,
        async agentType => {
          const failedRun = {
            run: { label: `${step.name}:${agentType}`, model: '', tokens: 0, tools: 0, ms: 0, output: '', failed: true },
          }
          let result
          try {
            const agentDef = agentMap.get(agentType)
            result = agentDef
              ? await runOneAgent({
                  label: `${step.name}:${agentType}`,
                  agentDef,
                  promptText: buildWorkerPrompt(def, task, state.artifact, step),
                  toolUseContext,
                  canUseTool,
                  runId: state.runId,
                  abortController,
                })
              : failedRun
          } catch (error) {
            // Let a real abort reject pMap (handled below as `cancelled`); any
            // other throw (e.g. prompt assembly) degrades to a failed worker
            // instead of escaping runWorkflow as an unhandled rejection.
            if (isAbortError(error)) throw error
            logError(error)
            result = failedRun
          }
          // Bump live progress as each worker settles (the `+1` is synchronous,
          // so concurrent workers never lose an increment).
          state = { ...state, agentsDone: (state.agentsDone ?? 0) + 1, updatedAt: Date.now() }
          await persist()
          return result
        },
        { concurrency: concurrencyCap() },
      )
      workerRuns = results.map(r => r.run)
    } catch (error) {
      if (isAbortError(error)) {
        state = { ...state, status: 'cancelled', updatedAt: Date.now() }
        await persist()
        break
      }
      throw error
    }

    // Record the phase (decision still pending) and show it on the board.
    const phase: PhaseRecord = {
      step: step.name,
      stepIndex,
      agents: workerRuns,
      synthesis: '',
      decision: null,
      at: Date.now(),
    }
    state = {
      ...state,
      history: [...state.history, phase],
      totalTokens: state.totalTokens + workerRuns.reduce((n, a) => n + a.tokens, 0),
      updatedAt: Date.now(),
    }
    await persist()

    // No-survivor floor: if every worker in this phase failed there is nothing
    // for main to synthesize — fail rather than advance on empty inputs.
    if (step.agents.length > 0 && workerRuns.every(r => r.failed)) {
      logError(new Error(`workflow phase "${step.name}": all ${workerRuns.length} worker(s) failed`))
      state = { ...state, status: 'failed', updatedAt: Date.now() }
      await persist()
      break
    }

    if (signal?.aborted) {
      state = { ...state, status: 'cancelled', updatedAt: Date.now() }
      await persist()
      break
    }

    // (2) Main synthesizes the full run state and decides the flow.
    const decisionTool = createSyntheticOutputTool(buildDecisionSchema(step))
    if (!('tool' in decisionTool)) {
      logError(new Error(`workflow decision schema build failed: ${decisionTool.error}`))
      state = { ...state, status: 'failed', updatedAt: Date.now() }
      await persist()
      break
    }
    const extraTools = [decisionTool.tool]

    let mainResult
    try {
      mainResult = await runOneAgent({
        label: 'main',
        agentDef: mainDef,
        promptText: buildMainContext(state, def),
        toolUseContext,
        canUseTool,
        extraTools,
        runId: state.runId,
        abortController,
      })
    } catch (error) {
      if (isAbortError(error)) {
        state = { ...state, status: 'cancelled', updatedAt: Date.now() }
        await persist()
        break
      }
      throw error
    }

    const parsed = StepDecisionSchema.safeParse(mainResult.structuredOutput)
    // Attach main's stats + synthesis to the phase record.
    const updatedHistory = [...state.history]
    updatedHistory[updatedHistory.length - 1] = {
      ...phase,
      synthesis: mainResult.run.output,
      decision: parsed.success ? parsed.data : null,
      agents: [...workerRuns, mainResult.run],
    }
    state = {
      ...state,
      history: updatedHistory,
      artifact: mainResult.run.output.trim() ? mainResult.run.output : state.artifact,
      totalTokens: state.totalTokens + mainResult.run.tokens,
      updatedAt: Date.now(),
    }

    if (!parsed.success) {
      logError(new Error(`workflow main produced no valid decision: ${parsed.error?.message ?? 'no decision'}`))
      state = { ...state, status: 'failed', updatedAt: Date.now() }
      await persist()
      break
    }

    // (3) Apply the decision (pure reducer) and persist.
    const reduced = applyDecision(state, parsed.data, def)
    state = {
      ...state,
      currentStep: reduced.currentStep,
      status: reduced.status,
      refineCounts: reduced.refineCounts,
      transitions: reduced.transitions,
      updatedAt: reduced.updatedAt,
    }
    await persist()
  }

  return state
}
