/**
 * The process-wide session state — barrel over ./state/.
 *
 * ~360 call sites across the codebase keep importing from here; new code
 * should prefer importing directly from the relevant submodule.
 *
 * Splitting layout:
 *   types.ts            — every type, including the 239-line State shape.
 *                         Values-free, so it can sit under everything else
 *   store.ts            — getInitialState, the runtime-state listener Set and
 *                         the STATE singleton itself. Imports nothing from its
 *                         siblings; every other module reaches STATE from here
 *   session.ts          — the session id, switchSession/regenerateSessionId and
 *                         the sessionSwitched funnel both go through
 *   cwd.ts              — originalCwd, projectRoot, cwd, direct-connect url
 *   cost.ts             — durations, cost, tokens, turn counters, lines changed,
 *                         request ids, scroll drain, model usage and strings
 *   telemetry.ts        — the otel meter, its eight counters and the providers
 *   sessionFlags.ts     — the write-once startup switches (interactivity, client
 *                         type, settings sources, credential fds, plugin list)
 *   sdkHooks.ts         — last API request, cached CLAUDE.md, error ring, init
 *                         schema, registered hook callbacks
 *   sessionArtifacts.ts — what a session accumulates and drops: cron tasks,
 *                         pending wakeup, trust, plan/auto mode, skills, teams
 *   latches.ts          — the sticky, cache-preserving bits: beta headers, LSP
 *                         defer, large-prompt, section cache, channels
 *   reset.ts            — resetStateForTests, the one writer that reaches every
 *                         cluster at once
 *
 * The dependency graph is a DAG rooted at store.ts, with no cycles: latches.ts
 * and sessionFlags.ts take the listener Set from it, session.ts takes
 * clearBetaHeaderLatches from latches.ts, and reset.ts takes cost.ts's
 * resetTurnTokenState. That hook and the internal types (State,
 * RegisteredHookMatcher, RuntimeStateChangeListener) are deliberately NOT
 * re-exported here — they were never part of this module's surface.
 */
export type {
  ChannelEntry,
  InvokedSkillInfo,
  SessionCronTask,
  SessionWakeup,
} from 'src/platform/bootstrap/state/types.js'
export {
  notifyRuntimeStateChange,
  onRuntimeStateChange,
} from 'src/platform/bootstrap/state/store.js'
export {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getAdditionalDirectoriesForClaudeMd,
  getAfkModeHeaderLatched,
  getAllowedChannels,
  getDeferredDeltaLegacySession,
  getFastModeHeaderLatched,
  getHasDevChannels,
  getLargeSystemPromptDetected,
  getLastEmittedDate,
  getPromptId,
  getReplBridgeHandle,
  getSessionEpochMs,
  getSystemPromptSectionCache,
  getThinkingClearLatched,
  isLspDeferLatched,
  isReplBridgeActive,
  latchLspDefer,
  setAdditionalDirectoriesForClaudeMd,
  setAfkModeHeaderLatched,
  setAllowedChannels,
  setDeferredDeltaLegacySession,
  setFastModeHeaderLatched,
  setHasDevChannels,
  setLargeSystemPromptDetected,
  setLastEmittedDate,
  setPromptId,
  setSystemPromptSectionCacheEntry,
  setThinkingClearLatched,
} from 'src/platform/bootstrap/state/latches.js'
export {
  getParentSessionId,
  getSessionId,
  getSessionProjectDir,
  onSessionSwitch,
  regenerateSessionId,
  switchSession,
} from 'src/platform/bootstrap/state/session.js'
export {
  getCwdState,
  getDirectConnectServerUrl,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setDirectConnectServerUrl,
  setOriginalCwd,
  setProjectRoot,
} from 'src/platform/bootstrap/state/cwd.js'
export {
  addToToolDuration,
  addToTotalCostState,
  addToTotalDurationState,
  addToTotalLinesChanged,
  addToTurnClassifierDuration,
  addToTurnHookDuration,
  consumePostCompaction,
  flushInteractionTime,
  getBudgetContinuationCount,
  getCurrentTurnTokenBudget,
  getInitialMainLoopModel,
  getIsScrollDraining,
  getLastApiCompletionTimestamp,
  getLastInteractionTime,
  getLastMainRequestId,
  getMainLoopModelOverride,
  getModelStrings,
  getModelUsage,
  getSdkBetas,
  getStatsStore,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getTurnClassifierCount,
  getTurnClassifierDurationMs,
  getTurnHookCount,
  getTurnHookDurationMs,
  getTurnOutputTokens,
  getTurnToolCount,
  getTurnToolDurationMs,
  getUsageForModel,
  hasUnknownModelCost,
  incrementBudgetContinuationCount,
  markPostCompaction,
  markScrollActivity,
  markTurnEnd,
  markTurnStart,
  resetCostState,
  resetModelStringsForTestingOnly,
  resetTotalDurationStateAndCost_FOR_TESTS_ONLY,
  resetTurnClassifierDuration,
  resetTurnHookDuration,
  resetTurnToolDuration,
  setCostStateForRestore,
  setHasUnknownModelCost,
  setInitialMainLoopModel,
  setLastApiCompletionTimestamp,
  setLastMainRequestId,
  setMainLoopModelOverride,
  setModelStrings,
  setSdkBetas,
  setStatsStore,
  snapshotOutputTokensForTurn,
  updateLastInteractionTime,
  waitForScrollIdle,
} from 'src/platform/bootstrap/state/cost.js'
export {
  getAgentColorMap,
  getAllowedSettingSources,
  getApiKeyFromFd,
  getClientType,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getInlinePlugins,
  getIsInteractive,
  getIsNonInteractiveSession,
  getKairosActive,
  getOauthTokenFromFd,
  getQuestionPreviewFormat,
  getScheduledTasksEnabled,
  getSdkAgentProgressSummariesEnabled,
  getSessionBypassPermissionsMode,
  getSessionIngressToken,
  getSessionSource,
  getStrictToolResultPairing,
  getUseCoworkPlugins,
  getUserMsgOptIn,
  preferThirdPartyAuthentication,
  setAllowedSettingSources,
  setApiKeyFromFd,
  setClientType,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setInlinePlugins,
  setIsInteractive,
  setKairosActive,
  setOauthTokenFromFd,
  setQuestionPreviewFormat,
  setScheduledTasksEnabled,
  setSdkAgentProgressSummariesEnabled,
  setSessionBypassPermissionsMode,
  setSessionIngressToken,
  setSessionSource,
  setStrictToolResultPairing,
  setUseCoworkPlugins,
  setUserMsgOptIn,
} from 'src/platform/bootstrap/state/sessionFlags.js'
export {
  addToInMemoryErrorLog,
  clearRegisteredHooks,
  clearRegisteredPluginHooks,
  getCachedClaudeMdContent,
  getInitJsonSchema,
  getLastAPIRequest,
  getLastAPIRequestMessages,
  getLastClassifierRequests,
  getRegisteredHooks,
  registerHookCallbacks,
  resetSdkInitState,
  setCachedClaudeMdContent,
  setInitJsonSchema,
  setLastAPIRequest,
  setLastAPIRequestMessages,
  setLastClassifierRequests,
} from 'src/platform/bootstrap/state/sdkHooks.js'
export {
  addInvokedSkill,
  addSessionCronTask,
  clearInvokedSkills,
  clearInvokedSkillsForAgent,
  clearPendingSessionWakeup,
  getInvokedSkills,
  getInvokedSkillsForAgent,
  getIsRemoteMode,
  getMainThreadAgentType,
  getPendingSessionWakeup,
  getPlanSlugCache,
  getSessionCreatedTeams,
  getSessionCronTasks,
  getSessionTrustAccepted,
  getTeleportedSessionInfo,
  handleAutoModeTransition,
  handlePlanModeTransition,
  hasExitedPlanModeInSession,
  isSessionPersistenceDisabled,
  markFirstTeleportMessageLogged,
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  removeSessionCronTasks,
  setHasExitedPlanMode,
  setMainThreadAgentType,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
  setPendingSessionWakeup,
  setSessionPersistenceDisabled,
  setSessionTrustAccepted,
  setTeleportedSessionInfo,
} from 'src/platform/bootstrap/state/sessionArtifacts.js'
export { resetStateForTests } from 'src/platform/bootstrap/state/reset.js'
