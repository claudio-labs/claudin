// A forked skill whose frontmatter says `background: true` runs as a
// background agent: the Skill call returns at once, and the skill's result
// reaches the model later as a task notification, the way an Agent call with
// `run_in_background` does. Claude Code 2.1.321 backgrounds every forked skill
// unless it says `background: false`; here it is opt-in, as an Agent runs
// inline unless asked.
//
// It stays inline whenever nothing could drain a background agent: a
// sub-agent's call (only main owns background agents, autoBackground.ts),
// `-p`, and CLAUDIN_DISABLE_BACKGROUND_TASKS — isRunInBackgroundHidden.

import { runWithAgentContext } from 'src/agent/coordinator/agentContext.js'
import { prepareForkedCommandContext } from 'src/agent/coordinator/forkedAgent.js'
import { getParentSessionId } from 'src/agent/coordinator/teammate.js'
import { registerAsyncAgent } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import { getAgentModel } from 'src/providers/model/agent.js'
import type { ModelAlias } from 'src/providers/model/aliases.js'
import { createAgentId } from 'src/shared/data/uuid.js'
import type { Command, PromptCommand } from 'src/shared/types/command.js'
import { asAgentId } from 'src/shared/types/ids.js'
import { runAsyncAgentLifecycle } from 'src/tools/AgentTool/agentToolUtils.js'
import { ownsBackgroundAgents } from 'src/tools/AgentTool/autoBackground.js'
import { runAgent } from 'src/tools/AgentTool/runAgent.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

/** Whether this Skill call launches the skill as a background agent. */
export function shouldRunSkillInBackground(
  command: Command | undefined,
  callerAgentId: string | undefined,
  backgroundHidden: boolean,
): boolean {
  return (
    command?.type === 'prompt' &&
    command.context === 'fork' &&
    command.background === true &&
    ownsBackgroundAgents(callerAgentId) &&
    !backgroundHidden
  )
}

export type BackgroundSkillDeps = {
  register: typeof registerAsyncAgent
  runLifecycle: typeof runAsyncAgentLifecycle
  stream: typeof runAgent
}

const LIVE_DEPS: BackgroundSkillDeps = {
  register: registerAsyncAgent,
  runLifecycle: runAsyncAgentLifecycle,
  stream: runAgent,
}

/** Starts the skill's fork as a background agent and returns its id at once. */
export async function launchSkillInBackground(
  command: Command & PromptCommand,
  commandName: string,
  args: string | undefined,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  deps: BackgroundSkillDeps = LIVE_DEPS,
): Promise<{ agentId: string }> {
  const startTime = Date.now()
  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)
  // The skill's effort goes into the definition so runAgent applies it, as
  // for a foreground fork.
  const agentDefinition = command.effort !== undefined ? { ...baseAgent, effort: command.effort } : baseAgent
  const description = `/${commandName}`
  // In-process teammates get a no-op setAppState; setAppStateForTasks reaches
  // the root store so the task shows and its notification is delivered.
  const rootSetAppState = context.setAppStateForTasks ?? context.setAppState
  const task = deps.register({
    agentId: createAgentId(),
    description,
    prompt: skillContent,
    selectedAgent: agentDefinition,
    setAppState: rootSetAppState,
    toolUseId: context.toolUseId,
    parentAgentId: context.agentId,
  })
  const agentId = task.agentId
  const abortController = task.abortController!
  const toolUseContext: ToolUseContext = { ...context, getAppState: modifiedGetAppState }
  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    context.options.mainLoopModel,
    command.model as ModelAlias | undefined,
    context.getAppState().toolPermissionContext.mode,
  )

  void runWithAgentContext(
    {
      agentId,
      parentSessionId: getParentSessionId(),
      agentType: 'subagent' as const,
      subagentName: agentDefinition.agentType,
      isBuiltIn: false,
    },
    () =>
      deps.runLifecycle({
        taskId: agentId,
        abortController,
        makeStream: onCacheSafeParams =>
          deps.stream({
            agentDefinition,
            promptMessages,
            toolUseContext,
            canUseTool,
            isAsync: true,
            querySource: 'agent:custom',
            model: command.model as ModelAlias | undefined,
            availableTools: context.options.tools,
            override: { agentId: asAgentId(agentId), abortController },
            onCacheSafeParams,
            description,
          }),
        metadata: {
          prompt: skillContent,
          resolvedAgentModel,
          isBuiltInAgent: false,
          startTime,
          agentType: agentDefinition.agentType,
          isAsync: true,
        },
        description,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: agentId,
        enableSummarization: false,
        getWorktreeResult: async () => ({}),
      }),
  )

  return { agentId }
}
