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
} from 'src/services/messages/text.js'

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
} from 'src/services/messages/constants.js'

export {
  AUTO_REJECT_MESSAGE,
  DONT_ASK_REJECT_MESSAGE,
  isClassifierDenial,
  buildYoloRejectionMessage,
  buildClassifierUnavailableMessage,
} from 'src/services/messages/rejection.js'

export { PLAN_PHASE4_CONTROL } from 'src/services/messages/planMode.js'

export {
  isSyntheticMessage,
  getLastAssistantMessage,
  hasToolCallsInLastAssistantTurn,
  isNotEmptyMessage,
  isToolUseResultMessage,
  isSystemLocalCommandMessage,
  isCompactBoundaryMessage,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  shouldShowUserMessage,
  isThinkingMessage,
  countToolCalls,
  hasSuccessfulToolCall,
} from 'src/services/messages/predicates.js'

export {
  normalizeMessages,
  reorderMessagesInUI,
  stripToolReferenceBlocksFromUserMessage,
  stripCallerFieldFromAssistantMessage,
  normalizeMessagesForAPI,
  mergeUserMessagesAndToolResults,
  normalizeContentFromAPI,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  filterOrphanedThinkingOnlyMessages,
  stripSignatureBlocks,
  ensureToolResultPairing,
  stripAdvisorBlocks,
  stripOldNarrationBlocks,
  stripOldThinkingBlocks,
} from 'src/services/messages/normalize.js'

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
  createSystemAPIErrorMessage,
  createToolUseSummaryMessage,
} from 'src/services/messages/factories.js'

export {
  getToolResultIDs,
  buildMessageLookups,
  EMPTY_LOOKUPS,
  buildSubagentLookups,
  getSiblingToolUseIDsFromLookup,
  getProgressMessagesFromLookup,
  hasUnresolvedHooksFromLookup,
  getToolUseIDs,
} from 'src/services/messages/lookups.js'

export { getToolUseID } from 'src/services/messages/toolUseID.js'

export {
  type StreamingToolUse,
  type StreamingThinking,
  handleMessageFromStream,
} from 'src/services/messages/streaming.js'

export { normalizeAttachmentForAPI } from 'src/services/messages/attachments.js'
