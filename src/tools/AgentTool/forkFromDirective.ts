// `/fork <directive>` and `/subtask <task>`: a background agent that inherits
// the whole conversation, started by the user rather than by an Agent call.
// Claude Code 2.1.323's spawnForkFromDirective, without the parts this fork
// has no subsystem for (fleet sessions, concurrency slots, review tools).
//
// There is no parent tool_use to clone (buildForkedMessages), so the child
// gets the conversation as is plus one user message carrying the directive.
// No size gate (forkGate.ts): the user asked for the fork by name, and Claude
// Code has none on this path either.

import { runWithAgentContext } from 'src/agent/coordinator/agentContext.js'
import { isCoordinatorMode } from 'src/agent/coordinator/coordinatorMode.js'
import { getLastCacheSafeParams } from 'src/agent/coordinator/forkedAgent.js'
import { getParentSessionId } from 'src/agent/coordinator/teammate.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { getQuerySourceForAgent } from 'src/agent/promptCategory.js'
import { registerAsyncAgent } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import { getAgentModel } from 'src/providers/model/agent.js'
import { createAgentId } from 'src/shared/data/uuid.js'
import { asAgentId } from 'src/shared/types/ids.js'
import { allocateAgentName, registerAgentName } from 'src/tools/AgentTool/agentName.js'
import { runAsyncAgentLifecycle } from 'src/tools/AgentTool/agentToolUtils.js'
import { buildChildMessage, FORK_AGENT } from 'src/tools/AgentTool/forkSubagent.js'
import { runAgent } from 'src/tools/AgentTool/runAgent.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export type ForkFromDirectiveResult =
  | { kind: 'spawned'; name: string; agentId: string }
  | { kind: 'no-turn' }
  | { kind: 'coordinator' }

export type ForkFromDirectiveDeps = {
  register: typeof registerAsyncAgent
  runLifecycle: typeof runAsyncAgentLifecycle
  stream: typeof runAgent
  savedParams: typeof getLastCacheSafeParams
  coordinatorMode: typeof isCoordinatorMode
}

const LIVE_DEPS: ForkFromDirectiveDeps = {
  register: registerAsyncAgent,
  runLifecycle: runAsyncAgentLifecycle,
  stream: runAgent,
  savedParams: getLastCacheSafeParams,
  coordinatorMode: isCoordinatorMode,
}

/** The directive's first three words as a slug, at most 24 chars; `fork` when nothing is left. */
export function forkNameFromDirective(directive: string): string {
  return (
    directive
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join('-')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'fork'
  )
}

/** The directive on one line, at most 50 chars. */
export function forkDescription(directive: string): string {
  const flat = directive.replace(/\s+/g, ' ').trim()
  return flat.length > 50 ? `${flat.slice(0, 49)}…` : flat
}

export async function spawnForkFromDirective(
  directive: string,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  deps: ForkFromDirectiveDeps = LIVE_DEPS,
): Promise<ForkFromDirectiveResult> {
  if (deps.coordinatorMode()) return { kind: 'coordinator' }
  // The parent's rendered prompt keeps the child's prefix cache-identical.
  // Outside a query it is the one the last main turn sent (stopHooks.ts).
  const systemPrompt = context.renderedSystemPrompt ?? deps.savedParams()?.systemPrompt
  if (!systemPrompt || !context.messages.some(m => m.type === 'assistant')) {
    return { kind: 'no-turn' }
  }

  const startTime = Date.now()
  // In-process teammates get a no-op setAppState; setAppStateForTasks reaches
  // the root store so the task shows and its notification is delivered.
  const rootSetAppState = context.setAppStateForTasks ?? context.setAppState
  const name = allocateAgentName(context.getAppState().agentNameRegistry, forkNameFromDirective(directive))
  const description = forkDescription(directive)
  const task = deps.register({
    agentId: createAgentId(),
    description,
    prompt: directive,
    selectedAgent: FORK_AGENT,
    setAppState: rootSetAppState,
    toolUseId: context.toolUseId,
    parentAgentId: context.agentId,
  })
  const agentId = task.agentId
  const abortController = task.abortController!
  registerAgentName(rootSetAppState, name, agentId)
  const resolvedAgentModel = getAgentModel(
    FORK_AGENT.model,
    context.options.mainLoopModel,
    undefined,
    context.getAppState().toolPermissionContext.mode,
  )

  void runWithAgentContext(
    {
      agentId,
      parentSessionId: getParentSessionId(),
      agentType: 'subagent' as const,
      subagentName: FORK_AGENT.agentType,
      isBuiltIn: true,
    },
    () =>
      deps.runLifecycle({
        taskId: agentId,
        abortController,
        makeStream: onCacheSafeParams =>
          deps.stream({
            agentDefinition: FORK_AGENT,
            promptMessages: [createUserMessage({ content: [{ type: 'text', text: buildChildMessage(directive) }] })],
            toolUseContext: context,
            canUseTool,
            isAsync: true,
            querySource: getQuerySourceForAgent(FORK_AGENT.agentType, true),
            model: undefined,
            override: { systemPrompt, agentId: asAgentId(agentId), abortController },
            // The parent's exact tools and conversation: a cache-identical prefix.
            availableTools: context.options.tools,
            forkContextMessages: context.messages,
            useExactTools: true,
            onCacheSafeParams,
            description,
            agentName: name,
          }),
        metadata: {
          prompt: directive,
          resolvedAgentModel,
          isBuiltInAgent: true,
          startTime,
          agentType: FORK_AGENT.agentType,
          isAsync: true,
        },
        description,
        toolUseContext: context,
        rootSetAppState,
        agentIdForCleanup: agentId,
        enableSummarization: true,
        getWorktreeResult: async () => ({}),
      }),
  )

  return { kind: 'spawned', name, agentId }
}
