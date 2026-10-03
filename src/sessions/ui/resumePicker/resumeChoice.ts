/**
 * What choosing a session in the startup picker does: route a session of
 * another directory to a command, or load the conversation and take the
 * session over, step by step.
 */
import { feature } from 'bun:bundle'
import { dirname } from 'path'
import { restoreCostStateForResume } from 'src/agent/cost-tracker.js'
import { getOriginalCwd, switchSession } from 'src/platform/bootstrap/state.js'
import { updateSessionName } from 'src/sessions/concurrentSessions.js'
import { loadConversationForResume } from 'src/sessions/conversationRecovery.js'
import { checkCrossProjectResume } from 'src/sessions/crossProjectResume.js'
import { type RestoredAgent, shownAgentColor } from 'src/sessions/lifecycle/restore/agent.js'
import {
  agentDefinitionsForMode,
  enterSessionMode,
  recordSessionMode,
} from 'src/sessions/lifecycle/restore/coordinatorMode.js'
import type { SessionModeApi } from 'src/sessions/lifecycle/restore/types.js'
import {
  computeStandaloneAgentContext,
  restoreAgentFromSession,
  restoreWorktreeForResume,
} from 'src/sessions/sessionRestore.js'
import {
  adoptResumedSessionFile,
  getSessionIdFromLog,
  resetSessionFilePointer,
  restoreSessionMetadata,
} from 'src/sessions/sessionStorage.js'
import { errorMessage } from 'src/shared/errors.js'
import type { FileHistorySnapshot } from 'src/shared/fs/fileHistory.js'
import { logError } from 'src/shared/log.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { LogOption } from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'
import { renameRecordingForSession } from 'src/terminal/image/asciicast.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { AgentDefinition, AgentDefinitionsResult } from 'src/tools/AgentTool/loadAgentsDir.js'

/** What the REPL opens with. */
export type ResumedSession = {
  messages: Message[]
  fileHistorySnapshots: FileHistorySnapshot[] | undefined
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  agentDefinition: AgentDefinition | undefined
}

export type ResumeOutcome =
  | { kind: 'resumed'; data: ResumedSession }
  | { kind: 'elsewhere'; command: string }
  | { kind: 'failed'; message: string }

export type ResumeChoiceOptions = {
  forkSession: boolean
  showAllProjects: boolean
  worktreePaths: string[]
  mainThreadAgentDefinition: AgentDefinition | undefined
  getAppState: () => AppState
  setAppState: (update: (prev: AppState) => AppState) => void
  /** Called once the session is known to be resumed here, before its transcript is read. */
  onLoading: () => void
}

type Conversation = NonNullable<Awaited<ReturnType<typeof loadConversationForResume>>>

/** The state the steps share; the agent fields are filled in as they run. */
type ResumeRun = {
  log: LogOption
  conversation: Conversation
  options: ResumeChoiceOptions
  modeApi: SessionModeApi | null
  agentDefinitions: AgentDefinitionsResult
  agent: RestoredAgent
}

export type ResumeStep = {
  name: string
  /** Whether a fork runs it too. A fork keeps its own id, cost, transcript and directory. */
  onFork: boolean
  run: (run: ResumeRun) => void | Promise<void>
}

function sessionIdOf(run: ResumeRun): string {
  const id = run.conversation.sessionId ?? getSessionIdFromLog(run.log)
  if (!id) throw new Error('The conversation has no session id.')
  return id
}

async function matchSessionMode(run: ResumeRun): Promise<void> {
  if (!enterSessionMode(run.conversation, run.modeApi)) return
  // The other mode has other agents: read them again, past the loader's cache.
  const reloaded = await agentDefinitionsForMode(true, {
    agentDefinitions: run.agentDefinitions,
    currentCwd: getOriginalCwd(),
    cliAgents: [],
  })
  run.agentDefinitions = reloaded
  run.options.setAppState(prev => ({ ...prev, agentDefinitions: reloaded }))
}

function takeSessionId(run: ResumeRun): void {
  const transcript = run.log.fullPath ?? run.conversation.fullPath
  switchSession(asSessionId(sessionIdOf(run)), transcript ? dirname(transcript) : null)
}

function restoreAgent(run: ResumeRun): void {
  run.agent = restoreAgentFromSession(
    run.conversation.agentSetting,
    run.options.mainThreadAgentDefinition,
    run.agentDefinitions,
  )
  const agentType = run.agent.agentType
  run.options.setAppState(prev => ({ ...prev, agent: agentType }))
}

function restoreAgentContext(run: ResumeRun): void {
  const context = computeStandaloneAgentContext(run.conversation.agentName, run.conversation.agentColor)
  if (context) run.options.setAppState(prev => ({ ...prev, standaloneAgentContext: context }))
}

function restoreMetadata(run: ResumeRun): void {
  const { conversation, options } = run
  restoreSessionMetadata({
    customTitle: conversation.customTitle,
    tag: conversation.tag,
    agentName: conversation.agentName,
    agentColor: conversation.agentColor,
    agentSetting: conversation.agentSetting,
    mode: conversation.mode,
    // A fork must not own the original's worktree.
    worktreeSession: options.forkSession ? undefined : conversation.worktreeSession,
    prNumber: conversation.prNumber,
    prUrl: conversation.prUrl,
    prRepository: conversation.prRepository,
  })
}

/** In the order they take effect. */
const RESUME_STEPS: readonly ResumeStep[] = [
  { name: 'match the session mode', onFork: true, run: matchSessionMode },
  { name: 'take the session id', onFork: false, run: takeSessionId },
  { name: 'rename the recording', onFork: false, run: () => renameRecordingForSession() },
  { name: 'reset the session file pointer', onFork: false, run: () => resetSessionFilePointer() },
  {
    name: 'restore the cost so far',
    onFork: false,
    run: run => {
      restoreCostStateForResume(sessionIdOf(run), run.conversation)
    },
  },
  { name: 'restore the agent', onFork: true, run: restoreAgent },
  { name: 'record the session mode', onFork: true, run: run => recordSessionMode(run.modeApi) },
  { name: 'restore the agent context', onFork: true, run: restoreAgentContext },
  {
    name: 'update the session name',
    onFork: true,
    run: run => {
      void updateSessionName(run.conversation.agentName).catch(logError)
    },
  },
  { name: 'restore the metadata', onFork: true, run: restoreMetadata },
  {
    name: 'enter the worktree',
    onFork: false,
    run: run => restoreWorktreeForResume(run.conversation.worktreeSession),
  },
  { name: 'adopt the transcript', onFork: false, run: () => adoptResumedSessionFile() },
]

export function resumeSteps(forkSession: boolean): readonly ResumeStep[] {
  return forkSession ? RESUME_STEPS.filter(step => step.onFork) : RESUME_STEPS
}

/** The coordinator-mode module, which exists only in the builds that have the mode. */
function sessionModeApi(): SessionModeApi | null {
  if (!feature('COORDINATOR_MODE')) return null
  return require('src/agent/coordinator/coordinatorMode.js') as typeof import('src/agent/coordinator/coordinatorMode.js')
}

export async function resumeChosenSession(log: LogOption, options: ResumeChoiceOptions): Promise<ResumeOutcome> {
  const where = checkCrossProjectResume(log, options.showAllProjects, options.worktreePaths)
  // A sibling worktree of this repository is resumed in place.
  if (where.isCrossProject && !where.isSameRepoWorktree) return { kind: 'elsewhere', command: where.command }

  options.onLoading()
  try {
    const conversation = await loadConversationForResume(log, undefined)
    if (!conversation) throw new Error('The conversation could not be read.')
    const run: ResumeRun = {
      log,
      conversation,
      options,
      modeApi: sessionModeApi(),
      agentDefinitions: options.getAppState().agentDefinitions,
      agent: { agentDefinition: undefined, agentType: undefined },
    }
    for (const step of resumeSteps(options.forkSession)) await step.run(run)
    return {
      kind: 'resumed',
      data: {
        messages: conversation.messages,
        fileHistorySnapshots: conversation.fileHistorySnapshots,
        agentName: conversation.agentName,
        agentColor: shownAgentColor(conversation.agentColor),
        agentDefinition: run.agent.agentDefinition,
      },
    }
  } catch (error) {
    logError(error)
    return { kind: 'failed', message: errorMessage(error) }
  }
}
