// Barrel module for the attachments subsystem.
//
// The historical monolith (4378 lines) was split into focused submodules
// under ./attachments/. This file preserves the public surface so callers
// across the codebase continue to import from 'src/services/attachments/attachments.js'.
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
  AgentMentionAttachment,
  HookAttachment,
  HookPermissionDecisionAttachment,
  Attachment,
} from './types.js'

export {
  PLAN_MODE_ATTACHMENT_CONFIG,
} from './config.js'

export {
  maybe,
  createAttachmentMessage,
  isFileReadDenied,
  isToolResultBlock,
  hasToolResultContent,
} from './shared.js'

export {
  extractAtMentionedFiles,
  extractMcpResourceMentions,
} from './mentions.js'

export {
  tryGetPDFReference,
  generateFileAttachment,
} from './file-pipeline.js'

export {
  memoryHeader,
  startRelevantMemoryPrefetch,
  filterDuplicateMemoryAttachments,
} from './memory.js'


export {
  getDeferredToolsDeltaAttachment,
  getAgentListingDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from './injections.js'

export {
  resetSentSkillNames,
  suppressNextSkillListing,
  _getSkillLatchSnapshotForTests,
  _seedSentSkillNamesForTests,
  filterToBundledAndMcp,
  resetSentBashGitInstructions,
  suppressNextBashGitInstructions,
  getBashGitInstructionsAttachment,
} from './skill-bash-gates.js'

export {
  getLSPDiagnosticAttachments,
} from './services.js'

export {
  getAttachments,
  getQueuedCommandAttachments,
  getAttachmentMessages,
} from './pipeline.js'
