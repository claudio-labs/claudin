import { resetTurnTokenState } from 'src/platform/bootstrap/state/cost.js'
import {
  getInitialState,
  STATE,
} from 'src/platform/bootstrap/state/store.js'
import type {
  InvokedSkillInfo,
  SessionCronTask,
  SessionWakeup,
  State,
} from 'src/platform/bootstrap/state/types.js'

export type {
  AttributedCounter,
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
  getActiveTimeCounter,
  getCodeEditToolDecisionCounter,
  getCommitCounter,
  getCostCounter,
  getEventLogger,
  getLocCounter,
  getLoggerProvider,
  getMeter,
  getMeterProvider,
  getPrCounter,
  getSessionCounter,
  getTokenCounter,
  getTracerProvider,
  setEventLogger,
  setLoggerProvider,
  setMeter,
  setMeterProvider,
  setTracerProvider,
} from 'src/platform/bootstrap/state/telemetry.js'
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

// Only used in tests
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  resetTurnTokenState()
  // Deliberately NOT sessionSwitched.clear(). Its three subscribers —
  // stableStubState's clipped-id map, loopSentinels' first-fire memory,
  // concurrentSessions' PID file — subscribe at module load and never
  // re-subscribe, so clearing here unsubscribed them for the REST of the
  // process: every later file in the same runner then asserted eviction
  // against a dead signal, and whether it broke depended on whether the
  // module happened to load before this call. registerSession() drops its
  // own previous listener now, which is the leak the clear was really for.
}

export function getSessionCronTasks(): SessionCronTask[] {
  return STATE.sessionCronTasks
}

export function addSessionCronTask(task: SessionCronTask): void {
  STATE.sessionCronTasks.push(task)
}

/**
 * Returns the number of tasks actually removed. Callers use this to skip
 * downstream work (e.g. the disk read in removeCronTasks) when all ids
 * were accounted for here.
 */
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  const remaining = STATE.sessionCronTasks.filter(t => !idSet.has(t.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  STATE.sessionCronTasks = remaining
  return removed
}

export function getPendingSessionWakeup(): SessionWakeup | null {
  return STATE.pendingSessionWakeup
}

/**
 * Set the session's single pending wakeup, replacing any existing one.
 * Returns true when a previously pending wakeup was replaced.
 */
export function setPendingSessionWakeup(wakeup: SessionWakeup): boolean {
  const replaced = STATE.pendingSessionWakeup !== null
  STATE.pendingSessionWakeup = wakeup
  return replaced
}

export function clearPendingSessionWakeup(): void {
  STATE.pendingSessionWakeup = null
}

export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // If switching TO plan mode, clear any pending exit attachment
  // This prevents sending both plan_mode and plan_mode_exit when user toggles quickly
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }

  // If switching out of plan mode, trigger the plan_mode_exit attachment
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // Auto↔plan transitions are handled by prepareContextForPlanMode (auto may
  // stay active through plan if opted in) and ExitPlanMode (restores mode).
  // Skip both directions so this function only handles direct auto transitions.
  if (
    (fromMode === 'auto' && toMode === 'plan') ||
    (fromMode === 'plan' && toMode === 'auto')
  ) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // If switching TO auto mode, clear any pending exit attachment
  // This prevents sending both auto_mode and auto_mode_exit when user toggles quickly
  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }

  // If switching out of auto mode, trigger the auto_mode_exit attachment
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}

// Teleported session tracking for reliability logging
export function setTeleportedSessionInfo(info: {
  sessionId: string | null
}): void {
  STATE.teleportedSessionInfo = {
    isTeleported: true,
    hasLoggedFirstMessage: false,
    sessionId: info.sessionId,
  }
}

export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null {
  return STATE.teleportedSessionInfo
}

export function markFirstTeleportMessageLogged(): void {
  if (STATE.teleportedSessionInfo) {
    STATE.teleportedSessionInfo.hasLoggedFirstMessage = true
  }
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  STATE.invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return STATE.invokedSkills
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    STATE.invokedSkills.clear()
    return
  }
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      STATE.invokedSkills.delete(key)
    }
  }
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === agentId) {
      STATE.invokedSkills.delete(key)
    }
  }
}

// Slow operations tracking removed (was internal-only).
// Functions kept as no-ops to avoid breaking callers.

const EMPTY_SLOW_OPERATIONS: ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> = []

export function addSlowOperation(
  _operation: string,
  _durationMs: number,
): void {}

export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> {
  return EMPTY_SLOW_OPERATIONS
}

export function getMainThreadAgentType(): string | undefined {
  return STATE.mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  STATE.mainThreadAgentType = agentType
}

export function getIsRemoteMode(): boolean {
  return STATE.isRemoteMode
}

export function setIsRemoteMode(value: boolean): void {
  STATE.isRemoteMode = value
}
