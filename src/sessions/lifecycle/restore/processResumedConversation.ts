/**
 * `--continue` and `--resume`: rebuild a session from its transcript before
 * the UI starts.
 *
 * The steps run in the order written below, and the order is part of the
 * behaviour: the metadata is cached before the worktree check (which may
 * record this run's own worktree over it), and the worktree check comes
 * before the transcript is adopted (adopting writes the cached metadata out).
 */
import { restoreCostStateForResume } from 'src/agent/cost-tracker.js'
import { switchSession } from 'src/platform/bootstrap/state.js'
import { updateSessionName } from 'src/sessions/lifecycle/processRecord/recordUpdates.js'
import {
  computeStandaloneAgentContext,
  type RestoredAgent,
  restoreAgentFromSession,
  shownAgentColor,
} from 'src/sessions/lifecycle/restore/agent.js'
import {
  agentDefinitionsForMode,
  enterSessionMode,
  recordSessionMode,
} from 'src/sessions/lifecycle/restore/coordinatorMode.js'
import { planResume, type ResumePlan } from 'src/sessions/lifecycle/restore/resumePlan.js'
import type {
  ProcessedResume,
  ResumeContext,
  ResumedConversation,
  ResumeOptions,
} from 'src/sessions/lifecycle/restore/types.js'
import { restoreWorktreeForResume } from 'src/sessions/lifecycle/restore/worktree.js'
import {
  adoptResumedSessionFile,
  resetSessionFilePointer,
  restoreSessionMetadata,
} from 'src/sessions/sessionStorage.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { AgentDefinitionsResult } from 'src/tools/AgentTool/loadAgentsDir.js'

type TakeOver = Extract<ResumePlan, { kind: 'takeOver' }>

export async function processResumedConversation(
  conversation: ResumedConversation,
  options: ResumeOptions,
  context: ResumeContext,
): Promise<ProcessedResume> {
  const modeSwitched = enterSessionMode(conversation, context.modeApi)
  const plan = planResume(conversation, options)

  if (plan.kind === 'takeOver') await takeOverSession(plan, conversation)
  restoreSessionMetadata(sessionMetadata(conversation, plan))
  if (plan.kind !== 'fork') restoreWorktreeForResume(conversation.worktreeSession)
  // Only a session taken over has a transcript to adopt. Adopting the current
  // session's own path would leave a metadata-only file for it; its metadata
  // is written with its first message instead.
  if (plan.kind === 'takeOver') adoptResumedSessionFile()

  const agent = restoreAgentFromSession(
    conversation.agentSetting,
    context.mainThreadAgentDefinition,
    context.agentDefinitions,
  )
  recordSessionMode(context.modeApi)
  void updateSessionName(conversation.agentName)
  const agentDefinitions = await agentDefinitionsForMode(modeSwitched, context)

  return {
    messages: conversation.messages,
    fileHistorySnapshots: conversation.fileHistorySnapshots,
    agentName: conversation.agentName,
    agentColor: shownAgentColor(conversation.agentColor),
    restoredAgentDef: agent.agentDefinition,
    initialState: initialStateFor(context.initialState, conversation, agent, agentDefinitions),
  }
}

async function takeOverSession(plan: TakeOver, conversation: ResumedConversation): Promise<void> {
  switchSession(plan.sessionId, plan.projectDir)
  // Nothing buffered for the session left behind may reach the resumed one.
  await resetSessionFilePointer()
  restoreCostStateForResume(plan.sessionId, conversation)
}

function sessionMetadata(
  conversation: ResumedConversation,
  plan: ResumePlan,
): Parameters<typeof restoreSessionMetadata>[0] {
  return {
    customTitle: conversation.customTitle,
    tag: conversation.tag,
    agentName: conversation.agentName,
    agentColor: conversation.agentColor,
    agentSetting: conversation.agentSetting,
    mode: conversation.mode,
    // A fork must never own the original's worktree: its exit could remove it.
    worktreeSession: plan.kind === 'fork' ? undefined : conversation.worktreeSession,
    prNumber: conversation.prNumber,
    prUrl: conversation.prUrl,
    prRepository: conversation.prRepository,
  }
}

function initialStateFor(
  initial: AppState,
  conversation: ResumedConversation,
  agent: RestoredAgent,
  agentDefinitions: AgentDefinitionsResult,
): AppState {
  const standaloneAgentContext = computeStandaloneAgentContext(
    conversation.agentName,
    conversation.agentColor,
  )
  return {
    ...initial,
    ...(agent.agentType !== undefined ? { agent: agent.agentType } : {}),
    ...(standaloneAgentContext ? { standaloneAgentContext } : {}),
    agentDefinitions,
  }
}
