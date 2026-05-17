export {
  withMemoryCorrectionHint,
  deriveShortMessageId,
  extractTag,
  deriveUUID,
  isEmptyMessageText,
  stripPromptXMLTags,
  getAssistantMessageText,
  getUserMessageText,
  textForResubmit,
  extractTextContent,
  getContentText,
  wrapInSystemReminder,
  wrapMessagesInSystemReminder,
  wrapCommandText,
} from './messages/text.js'

export {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  PLAN_REJECTION_PREFIX,
  DENIAL_WORKAROUND_GUIDANCE,
  NO_RESPONSE_REQUESTED,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  SYNTHETIC_MODEL,
  SYNTHETIC_MESSAGES,
  EMPTY_STRING_SET,
} from './messages/constants.js'

export {
  AUTO_REJECT_MESSAGE,
  DONT_ASK_REJECT_MESSAGE,
  isClassifierDenial,
  buildYoloRejectionMessage,
  buildClassifierUnavailableMessage,
} from './messages/rejection.js'

export { PLAN_PHASE4_CONTROL } from './messages/planMode.js'

export {
  isSyntheticMessage,
  getLastAssistantMessage,
  hasToolCallsInLastAssistantTurn,
  isNotEmptyMessage,
  isToolUseRequestMessage,
  isToolUseResultMessage,
  isSystemLocalCommandMessage,
  isCompactBoundaryMessage,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  shouldShowUserMessage,
  isThinkingMessage,
  countToolCalls,
  hasSuccessfulToolCall,
} from './messages/predicates.js'

export {
  normalizeMessages,
  reorderMessagesInUI,
  reorderAttachmentsForAPI,
  stripToolReferenceBlocksFromUserMessage,
  stripCallerFieldFromAssistantMessage,
  normalizeMessagesForAPI,
  mergeUserMessagesAndToolResults,
  mergeAssistantMessages,
  mergeUserMessages,
  mergeUserContentBlocks,
  normalizeContentFromAPI,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  filterOrphanedThinkingOnlyMessages,
  stripSignatureBlocks,
  ensureToolResultPairing,
  stripAdvisorBlocks,
  stripOldThinkingBlocks,
} from './messages/normalize.js'

export {
  createAssistantMessage,
  createAssistantAPIErrorMessage,
  createUserMessage,
  prepareUserContent,
  createUserInterruptionMessage,
  createSyntheticUserCaveatMessage,
  formatCommandInputTags,
  createModelSwitchBreadcrumbs,
  createProgressMessage,
  createToolResultStopMessage,
  createSystemMessage,
  createPermissionRetryMessage,
  createBridgeStatusMessage,
  createScheduledTaskFireMessage,
  createStopHookSummaryMessage,
  createTurnDurationMessage,
  createAwaySummaryMessage,
  createMemorySavedMessage,
  createAgentsKilledMessage,
  createApiMetricsMessage,
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createMicrocompactBoundaryMessage,
  createSystemAPIErrorMessage,
  createToolUseSummaryMessage,
} from './messages/factories.js'

export {
  hasUnresolvedHooks,
  getToolResultIDs,
  getSiblingToolUseIDs,
  type MessageLookups,
  buildMessageLookups,
  EMPTY_LOOKUPS,
  buildSubagentLookups,
  getSiblingToolUseIDsFromLookup,
  getProgressMessagesFromLookup,
  hasUnresolvedHooksFromLookup,
  getToolUseIDs,
} from './messages/lookups.js'

export { getToolUseID } from './messages/toolUseID.js'

export {
  type StreamingToolUse,
  type StreamingThinking,
  handleMessageFromStream,
} from './messages/streaming.js'

export { normalizeAttachmentForAPI } from './messages/attachments.js'
