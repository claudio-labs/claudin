// Barrel for src/services/session/sessionStorage.
//
// Originally a 5,361-line monolith; split in 11c (waves 1–5) into five
// concerns under src/services/session/:
//
//   pure/          — type guards, paths, first-prompt extraction, JSONL byte
//                    stripping, logging filters (no dependencies on Project
//                    or fs beyond paths). Consumed by every other concern,
//                    which is why it's its own module rather than the four
//                    suggested by the roadmap.
//   persistence/   — class Project (singleton, write queue, flushTimer),
//                    record* family, metadata lifecycle, flushSessionStorage,
//                    remote ingress (hydrateRemoteSession). The 3 test
//                    helpers (resetProjectForTesting et al.) live with
//                    Project because they manipulate the same module-level
//                    singleton state.
//   resume/        — loadTranscriptFile, buildConversationChain, subagent
//                    transcripts, memoized session-messages cache.
//   indexing/      — getSessionFilesLite, loadAllProjects*, searchSessions*,
//                    agent metadata sidecars, boundary-scan helpers.
//
// "migrations" from the roadmap correspond to compat readers distributed
// across the natural modules (stripPersistedToolUseResults* in
// pure/jsonlStripping.ts, <persisted-output> reader in
// resume/transcriptLoad.ts, parseJSONL tolerance in src/utils/data/json.ts).
//
// External consumers (32 importers) keep importing from this path; the
// barrel re-exports preserve every public name unchanged. The barrel
// snapshot test at __tests__/barrelExports.test.ts pins the public surface.
//
// On-disk format compatibility is byte-sensitive: see
// pure/jsonlStripping.ts header for the <persisted-output> contract that
// stable-stub depends on. Do not "clean up" the byte-level JSON helpers
// (isJsonWhitespaceByte / skipJsonWhitespace / findJsonValueEnd) — using
// JSON.parse there would allocate the tool_result blob before discarding
// it, defeating the OOM-prevention rationale.

export {
  EPHEMERAL_PROGRESS_TYPES,
  isChainParticipant,
  isEphemeralToolProgress,
  isLegacyProgressEntry,
  isTranscriptMessage,
  type LegacyProgressEntry,
} from './pure/typeGuards.js'

export {
  clearAgentTranscriptSubdir,
  getAgentTranscriptPath,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  MAX_TRANSCRIPT_READ_BYTES,
  setAgentTranscriptSubdir,
} from './pure/paths.js'

export {
  type AgentMetadata,
  deleteRemoteAgentMetadata,
  listRemoteAgentMetadata,
  readAgentMetadata,
  readRemoteAgentMetadata,
  type RemoteAgentMetadata,
  sessionIdExists,
  writeAgentMetadata,
  writeRemoteAgentMetadata,
} from './indexing/agents.js'

export {
  getProject,
  hydrateFromCCRv2InternalEvents,
  hydrateRemoteSession,
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
  setInternalEventReader,
  setInternalEventWriter,
  setRemoteIngressUrlForTesting,
  setSessionFileForTesting,
} from './persistence/project.js'

export {
  adoptResumedSessionFile,
  recordAttributionSnapshot,
  recordContentReplacement,
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
  recordFileHistorySnapshot,
  recordQueueOperation,
  recordSidechainTranscript,
  recordTranscript,
  removeTranscriptMessage,
  resetSessionFilePointer,
  type TeamInfo,
} from './persistence/record.js'

export {
  cacheSessionTitle,
  clearSessionMetadata,
  getCurrentSessionAgentColor,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  linkSessionToPR,
  reAppendSessionMetadata,
  restoreSessionMetadata,
  saveAgentColor,
  saveAgentName,
  saveAgentSetting,
  saveAiGeneratedTitle,
  saveCustomTitle,
  saveMode,
  saveTag,
  saveTaskSummary,
  saveWorktreeState,
} from './persistence/metadata.js'

export { flushSessionStorage } from './persistence/flush.js'

export {
  extractFirstPrompt,
  extractFirstPromptFromChunk,
  getFirstMeaningfulUserMessageTextContent,
  SKIP_FIRST_PROMPT_PATTERN,
} from './pure/firstPrompt.js'

export {
  cleanMessagesForLogging,
  getUserType,
  isLoggableMessage,
  removeExtraFields,
} from './pure/logging.js'

export {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
  buildConversationChain,
  checkResumeConsistency,
  findLatestMessage,
  recoverOrphanedParallelToolResults,
} from './resume/chain.js'

export {
  buildAttributionSnapshotChain,
  buildFileHistorySnapshotChain,
  loadTranscriptFile,
} from './resume/transcriptLoad.js'

export {
  clearSessionMessagesCache,
  doesMessageExistInSession,
} from './resume/cache.js'

export {
  extractAgentIdsFromMessages,
  extractTeammateTranscriptsFromTasks,
  getAgentTranscript,
  loadAllSubagentTranscriptsFromDisk,
  loadSubagentTranscripts,
} from './resume/subagents.js'

export { stripPersistedToolUseResultsFromJSONLBuffer } from './pure/jsonlStripping.js'

export {
  fetchLogs,
  findUnresolvedToolUse,
  getLastSessionLog,
  getLogByIndex,
  getNodeEnv,
  getSessionFilesLite,
  getSessionFilesWithMtime,
  getSessionIdFromLog,
  INITIAL_ENRICH_COUNT,
  isCustomTitleEnabled,
  isLiteLog,
  loadAllLogsFromSessionFile,
  loadFullLog,
  loadMessageLogs,
  loadTranscriptFromFile,
  enrichLogs,
} from './indexing/liteMetadata.js'

export {
  loadAllProjectsMessageLogs,
  loadAllProjectsMessageLogsProgressive,
  loadSameRepoMessageLogs,
  loadSameRepoMessageLogsProgressive,
  type SessionLogResult,
} from './indexing/crossProject.js'

export { searchSessionsByCustomTitle } from './indexing/search.js'
