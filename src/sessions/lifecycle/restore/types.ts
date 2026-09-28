/**
 * The shapes a resume works with. They follow what the callers already pass
 * in (the loader's result, the CLI's resume context) and read back, so that
 * the callers compile unchanged.
 */
import type { UUID } from 'crypto'

import type { FileHistorySnapshot } from 'src/shared/fs/fileHistory.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  CostStateEntry,
  PersistedWorktreeSession,
} from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from 'src/tools/AgentTool/loadAgentsDir.js'

export type SessionMode = 'coordinator' | 'normal'

/** A conversation loaded from its transcript, as `loadConversationForResume` returns it. */
export type ResumedConversation = {
  messages: Message[]
  sessionId: UUID | undefined
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: SessionMode
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  costState?: CostStateEntry
}

export type ResumeOptions = {
  forkSession: boolean
  sessionIdOverride?: string
  transcriptPath?: string
  /** Accepted from the callers; this build restores no attribution state. */
  includeAttribution?: boolean
}

/** The coordinator-mode module, in the builds that have one. */
export type SessionModeApi = {
  matchSessionMode(mode?: string): string | undefined
  isCoordinatorMode(): boolean
}

export type ResumeContext = {
  modeApi: SessionModeApi | null
  mainThreadAgentDefinition: AgentDefinition | undefined
  agentDefinitions: AgentDefinitionsResult
  currentCwd: string
  cliAgents: AgentDefinition[]
  initialState: AppState
}

export type ProcessedResume = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  restoredAgentDef: AgentDefinition | undefined
  initialState: AppState
}
