// Barrel module for the attachments subsystem.
//
// The historical monolith (4378 lines) was split into focused submodules
// under ./attachments/. This file preserves the public surface so callers
// across the codebase continue to import from 'src/utils/attachments'.
//
// New code should prefer importing directly from the relevant submodule.
// Splitting layout:
//   types.ts            — Attachment union + per-variant interfaces
//   config.ts           — tunables (turn counts, size limits, intervals)
//   shared.ts           — maybe(), createAttachmentMessage(),
//                          isFileReadDenied(), isToolResultBlock(),
//                          hasToolResultContent()
//   mentions.ts         — @-mention extractors (files, agents, MCP resources)
//   file-pipeline.ts    — generateFileAttachment + tryGetPDFReference
//   memory.ts           — nested-memory traversal, relevant-memory prefetch
//   lifecycle.ts        — plan/auto mode + reminder attachments
//   injections.ts       — per-turn deltas, gauges, ad-hoc signals
//   skill-bash-gates.ts — per-process latches (skill listing, bash/git)
//   services.ts         — IDE, mentions processing, diagnostics, mailbox
//   pipeline.ts         — getAttachments orchestrator + getAttachmentMessages

export type {
  FileAttachment,
  CompactFileReferenceAttachment,
  PDFReferenceAttachment,
  AlreadyReadFileAttachment,
  AgentMentionAttachment,
  AsyncHookResponseAttachment,
  HookAttachment,
  HookPermissionDecisionAttachment,
  HookSystemMessageAttachment,
  HookCancelledAttachment,
  HookErrorDuringExecutionAttachment,
  HookSuccessAttachment,
  HookNonBlockingErrorAttachment,
  Attachment,
  TeammateMailboxAttachment,
  TeamContextAttachment,
} from './attachments/types.js'

export {
  TODO_REMINDER_CONFIG,
  PLAN_MODE_ATTACHMENT_CONFIG,
  AUTO_MODE_ATTACHMENT_CONFIG,
  RELEVANT_MEMORIES_CONFIG,
  VERIFY_PLAN_REMINDER_CONFIG,
  MAX_MEMORY_LINES,
  MAX_MEMORY_BYTES,
} from './attachments/config.js'

export {
  maybe,
  createAttachmentMessage,
  isFileReadDenied,
  isToolResultBlock,
  hasToolResultContent,
} from './attachments/shared.js'

export {
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  extractAgentMentions,
  parseAtMentionedFileLines,
  type AtMentionedFileLines,
} from './attachments/mentions.js'

export {
  tryGetPDFReference,
  generateFileAttachment,
} from './attachments/file-pipeline.js'

export {
  getDirectoriesToProcess,
  memoryFilesToAttachments,
  getNestedMemoryAttachmentsForFile,
  getNestedMemoryAttachments,
  collectSurfacedMemories,
  readMemoriesForSurfacing,
  memoryHeader,
  startRelevantMemoryPrefetch,
  collectRecentSuccessfulTools,
  filterDuplicateMemoryAttachments,
  type MemoryPrefetch,
} from './attachments/memory.js'

export {
  getPlanModeAttachments,
  getPlanModeExitAttachment,
  getAutoModeAttachments,
  getAutoModeExitAttachment,
  todoListToSnapshot,
  taskListToSnapshot,
  getTodoReminderAttachments,
  getTaskReminderAttachments,
  getUnifiedTaskAttachments,
  getVerifyPlanReminderTurnCount,
  getVerifyPlanReminderAttachment,
  getCompactionReminderAttachment,
} from './attachments/lifecycle.js'

export {
  getDateChangeAttachments,
  getUltrathinkEffortAttachment,
  getDeferredToolsDeltaAttachment,
  getAgentListingDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
  getClaudeMdDeltaAttachment,
  getGitStatusDeltaAttachment,
  getMemoryDeltaAttachment,
  getCriticalSystemReminderAttachment,
  getOutputStyleAttachment,
  getTeamContextAttachment,
  getTokenUsageAttachment,
  getOutputTokenUsageAttachment,
  getMaxBudgetUsdAttachment,
  getContextEfficiencyAttachment,
} from './attachments/injections.js'

export {
  resetSentSkillNames,
  suppressNextSkillListing,
  _getSkillLatchSnapshotForTests,
  _seedSentSkillNamesForTests,
  filterToBundledAndMcp,
  getSkillListingAttachments,
  resetSentBashGitInstructions,
  suppressNextBashGitInstructions,
  getBashGitInstructionsAttachment,
} from './attachments/skill-bash-gates.js'

export {
  getSelectedLinesFromIDE,
  getOpenedFileFromIDE,
  processAtMentionedFiles,
  processAgentMentions,
  processMcpResourceAttachments,
  getChangedFiles,
  getDynamicSkillAttachments,
  getDiagnosticAttachments,
  getLSPDiagnosticAttachments,
  getAsyncHookResponseAttachments,
  getTeammateMailboxAttachments,
} from './attachments/services.js'

export {
  getAttachments,
  getQueuedCommandAttachments,
  getAgentPendingMessageAttachments,
  getAttachmentMessages,
} from './attachments/pipeline.js'
