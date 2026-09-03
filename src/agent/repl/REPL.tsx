import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { feature } from 'bun:bundle';
import { snapshotOutputTokensForTurn, getTotalInputTokens } from 'src/platform/bootstrap/state.js';
import { count } from 'src/shared/data/array.js';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- / n N Esc [ v are bare letters in transcript modal context, same class as g/G/j/k in ScrollKeybindingHandler
import { useInput } from 'src/terminal/ink.js';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import { useSearchHighlight } from 'src/terminal/ink/hooks/use-search-highlight.js';
import type { JumpHandle } from 'src/terminal/VirtualMessageList.js';
import { median } from 'src/agent/repl/utils/math.js';
import { TranscriptModeFooter } from 'src/agent/repl/components/TranscriptModeFooter.js';
import { TranscriptSearchBar } from 'src/agent/repl/components/TranscriptSearchBar.js';
import { AnimatedTerminalTitle } from 'src/agent/repl/components/AnimatedTerminalTitle.js';
import { REPLStatus } from 'src/agent/repl/components/REPLStatus.js';
import { REPLTranscriptView } from 'src/agent/repl/components/REPLTranscriptView.js';
import { renderREPLDialogs } from 'src/agent/repl/components/REPLDialogs.js';
import { getFocusedInputDialog } from 'src/agent/repl/utils/getFocusedInputDialog.js';
import { useReplExit } from 'src/agent/repl/hooks/useReplExit.js';
import { useReplLifecycle } from 'src/agent/repl/hooks/useReplLifecycle.js';
import { resumeSession } from 'src/agent/repl/services/resumeSession.js';
import { useSandboxAsk } from 'src/agent/repl/controllers/useSandboxAsk.js';
import { useMessageActionsController } from 'src/agent/repl/controllers/useMessageActionsController.js';
import { useToolUseContext } from 'src/agent/repl/controllers/useToolUseContext.js';
import { useOnQuery } from 'src/agent/repl/controllers/useOnQuery.js';
import { useOnSubmit } from 'src/agent/repl/controllers/useOnSubmit.js';
import { renderMessagesToPlainText } from 'src/platform/exportRenderer.js';
import { openFileInExternalEditor } from 'src/shared/editor.js';
import { writeFile } from 'fs/promises';
import { Box, Text, useStdin, useTheme, useTerminalFocus, useTabStatus } from 'src/terminal/ink.js';
import { CostThresholdDialog } from 'src/permissions/ui/CostThresholdDialog.js';
import { IdleReturnDialog } from 'src/platform/IdleReturnDialog.js';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState, useCallback, useDeferredValue, useLayoutEffect } from 'react';
import { useNotifications } from 'src/terminal/contexts/notifications.js';
import { sendNotification } from 'src/platform/notifications/notifier.js';
import { useTerminalNotification } from 'src/terminal/ink/useTerminalNotification.js';
import { hasCursorUpViewportYankBug } from 'src/terminal/ink/terminal.js';
import instances from 'src/terminal/ink/instances.js';
import { createFileStateCacheWithSizeLimit, mergeReplacingLiveCache, READ_FILE_STATE_CACHE_SIZE } from 'src/shared/fs/fileStateCache.js';
import { updateLastInteractionTime, getLastInteractionTime, getOriginalCwd, getProjectRoot, getSessionId, switchSession, setCostStateForRestore, markTurnEnd, getTurnHookDurationMs, getTurnHookCount, getTurnToolDurationMs, getTurnToolCount, getTurnClassifierDurationMs, getTurnClassifierCount } from 'src/platform/bootstrap/state.js';
import { asSessionId, asAgentId } from 'src/shared/types/ids.js';
import { logForDebugging } from 'src/shared/debug.js';
import { QueryGuard } from 'src/agent/QueryGuard.js';
import { isEnvTruthy } from 'src/shared/envUtils.js';
import { formatTokens, truncateToWidth } from 'src/shared/text/format.js';
import { consumeEarlyInput } from 'src/terminal/input/earlyInput.js';
import { sendSandboxPermissionResponseViaMailbox } from 'src/agent/coordinator/swarm/permissionSync.js';
import { WorkerPendingPermission } from 'src/permissions/ui/WorkerPendingPermission.js';
import { injectUserMessageToTeammate, getAllInProcessTeammateTasks } from 'src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { isLocalAgentTask, queuePendingMessage, appendMessageToLocalAgent, type LocalAgentTaskState } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js';
import { registerLeaderToolUseConfirmQueue, unregisterLeaderToolUseConfirmQueue } from 'src/agent/coordinator/swarm/leaderPermissionBridge.js';
import { endInteractionSpan } from 'src/platform/telemetry/sessionTracing.js';
import { useLogMessages } from 'src/agent/hooks/useLogMessages.js';
import { useReplBridge } from 'src/platform/bridge/useReplBridge.js';
import { type Command, type ResumeEntrypoint } from 'src/commands/commands.js';
import type { PromptInputMode, QueuedCommand, VimMode } from 'src/shared/types/textInputTypes.js';
import { MessageSelector } from 'src/agent/ui/MessageSelector.js';
import { useIdeLogging } from 'src/platform/ide/useIdeLogging.js';
import { PermissionRequest, type ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js';
import { ElicitationDialog } from 'src/mcp/ui/ElicitationDialog.js';
import { PromptDialog } from 'src/platform/lifecycleHooks/ui/PromptDialog.js';
import type { PromptRequest, PromptResponse } from 'src/shared/types/hooks.js';
import PromptInput from 'src/terminal/prompt-input/PromptInput.js';
import { PromptInputQueuedCommands } from 'src/terminal/prompt-input/PromptInputQueuedCommands.js';
import { useRemoteSession } from 'src/sessions/hooks/useRemoteSession.js';
import { streamingTextStore, useStreamingTextPresence } from 'src/agent/hooks/useStreamingTextStore.js';
import { createCoalescedUpdater } from 'src/platform/install/coalescedUpdater.js';
import { useDirectConnect } from 'src/providers/hooks/useDirectConnect.js';
import type { DirectConnectConfig } from 'src/platform/server/directConnectManager.js';
import { useSSHSession } from 'src/sessions/hooks/useSSHSession.js';
import { useAssistantHistory } from 'src/agent/hooks/useAssistantHistory.js';
import type { SSHSession } from '../../platform/ssh/createSSHSession.js';
import { useMoreRight } from 'src/terminal/moreright/useMoreRight.js';
import { SpinnerWithVerb, BriefIdleStatus, type SpinnerMode } from 'src/terminal/spinner/Spinner.js';
import { getSystemPrompt } from 'src/agent/prompts/prompts.js';
import { buildEffectiveSystemPrompt } from 'src/agent/systemPrompt.js';
import { getSystemContext, getUserContext } from 'src/agent/context.js';
import { getMemoryFiles } from 'src/memory/instructions/claudemd.js';
import { startBackgroundHousekeeping } from 'src/platform/backgroundHousekeeping.js';
import { getTotalCost, saveCurrentSessionCosts, resetCostState, getStoredSessionCosts } from 'src/agent/cost-tracker.js';
import { useCostSummary } from 'src/agent/costHook.js';
import { useFpsMetrics } from 'src/terminal/contexts/fpsMetrics.js';
import { useAfterFirstRender } from 'src/terminal/hooks/useAfterFirstRender.js';
import { useDeferredHookMessages } from 'src/agent/hooks/useDeferredHookMessages.js';
import { useApiKeyVerification } from 'src/providers/hooks/useApiKeyVerification.js';
import { GlobalKeybindingHandlers } from 'src/terminal/hooks/useGlobalKeybindings.js';
import { CommandKeybindingHandlers } from 'src/terminal/hooks/useCommandKeybindings.js';
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js';
import { getShortcutDisplay } from 'src/terminal/keybindings/shortcutFormat.js';
import { CancelRequestHandler } from 'src/agent/hooks/useCancelRequest.js';
import { useExitOnCtrlCDWithKeybindings } from 'src/terminal/hooks/useExitOnCtrlCDWithKeybindings.js';
import { useBackgroundTaskNavigation } from 'src/agent/hooks/useBackgroundTaskNavigation.js';
import { useSwarmInitialization } from 'src/agent/coordinator/hooks/useSwarmInitialization.js';
import { useTeammateViewAutoExit } from 'src/agent/coordinator/hooks/useTeammateViewAutoExit.js';
import { errorMessage } from 'src/shared/errors.js';
import { profileCheckpoint } from 'src/platform/startupProfiler.js';

// Wave 6 audit — module-level guard so repl_first_paint fires exactly once,
// even under StrictMode double-invoke or HMR remounts. Not exported.
let _replFirstPaintMarked = false;
import { isHumanTurn } from 'src/agent/messages/messagePredicates.js';
import { logError } from 'src/shared/log.js';
// Dead code elimination: conditional imports
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const useVoiceIntegration: typeof import('src/terminal/voice/useVoiceIntegration.js').useVoiceIntegration = feature('VOICE_MODE') ? require('src/terminal/voice/useVoiceIntegration.js').useVoiceIntegration : () => ({
  stripTrailing: () => 0,
  handleKeyEvent: () => { },
  resetAnchor: () => { }
});
const VoiceKeybindingHandler: typeof import('src/terminal/voice/useVoiceIntegration.js').VoiceKeybindingHandler = feature('VOICE_MODE') ? require('src/terminal/voice/useVoiceIntegration.js').VoiceKeybindingHandler : () => null;
// The real modules behind these two imports were never carried into this
// fork (see the .d.ts stub comments in their directories); `typeof
// import(...)` can't type them since the stub exports a placeholder name,
// not the real one, so the shape is written out by hand instead, matching
// the always-used dummy fallback below.
const useFrustrationDetection: (messages: MessageType[], isLoading: boolean, hasActivePrompt: boolean, surveyActive: boolean) => {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted';
  handleTranscriptSelect: (selected: TranscriptShareResponse) => void;
} = () => ({
  state: 'closed',
  handleTranscriptSelect: () => { }
});
const useAntOrgWarningNotification: () => void = () => { };
// Dead code elimination: conditional import for coordinator mode
const getCoordinatorUserContext: (mcpClients: ReadonlyArray<{
  name: string;
}>, scratchpadDir?: string) => {
  [k: string]: string;
} = feature('COORDINATOR_MODE') ? require('src/agent/coordinator/coordinatorMode.js').getCoordinatorUserContext : () => ({});
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import useCanUseTool from 'src/permissions/useCanUseTool.js';
import type { Tool } from 'src/tools/Tool.js';
import { applyPermissionUpdate, applyPermissionUpdates, persistPermissionUpdate } from 'src/permissions/PermissionUpdate.js';
import { buildPermissionUpdates } from 'src/permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js';
import { stripDangerousPermissionsForAutoMode } from 'src/permissions/permissionSetup.js';
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js';
import { SLEEP_TOOL_NAME } from 'src/tools/SleepTool/prompt.js';
import { clearSpeculativeChecks } from 'src/tools/BashTool/bashPermissions.js';
import { getGlobalConfig, saveGlobalConfig, getGlobalConfigWriteCount } from 'src/platform/config/config.js';
import { hasConsoleBillingAccess } from 'src/providers/usage/billing.js';
import { logEvent, type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/platform/analytics/index.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js';
import { textForResubmit, handleMessageFromStream, type StreamingToolUse, type StreamingThinking, getMessagesAfterCompactBoundary, createUserMessage, createAssistantMessage, createTurnDurationMessage, createAgentsKilledMessage, createApiMetricsMessage, createSystemMessage, createCommandInputMessage, formatCommandInputTags } from 'src/agent/messages/messages.js';
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/shared/constants/xml.js';
import { escapeXml } from 'src/shared/data/xml.js';
import type { ThinkingConfig } from 'src/agent/context/thinking.js';
import { gracefulShutdownSync, isShuttingDown } from 'src/shared/proc/gracefulShutdown.js';
import { handlePromptSubmit, type PromptInputHelpers } from 'src/agent/handlePromptSubmit.js';
import { useQueueProcessor } from 'src/agent/hooks/useQueueProcessor.js';
import { useMailboxBridge } from 'src/platform/bridge/useMailboxBridge.js';
import type { Message as MessageType, UserMessage, ProgressMessage, HookResultMessage, PartialCompactDirection } from 'src/shared/types/message.js';
import { query } from 'src/agent/query.js';
import { useMergedClients } from 'src/mcp/hooks/useMergedClients.js';
import { getQuerySourceForREPL } from 'src/agent/promptCategory.js';
import { useMergedTools } from 'src/agent/hooks/useMergedTools.js';
import { useMergedCommands } from 'src/agent/hooks/useMergedCommands.js';
import { useSkillsChange } from 'src/platform/useSkillsChange.js';
import { useManagePlugins } from 'src/platform/useManagePlugins.js';
import { Messages } from 'src/agent/ui/Messages.js';
import { TaskListV2 } from 'src/agent/ui/TaskListV2.js';
import { TeammateViewHeader } from 'src/agent/ui/TeammateViewHeader.js';
import { useTasksV2WithCollapseEffect } from 'src/agent/hooks/useTasksV2.js';
import type { MCPServerConnection } from 'src/mcp/types.js';
import type { ScopedMcpServerConfig } from 'src/mcp/types.js';
import { randomUUID, type UUID } from 'crypto';
import { processSessionStartHooks } from 'src/sessions/sessionStart.js';
import { executeSessionEndHooks, getSessionEndHookTimeoutMs } from 'src/platform/lifecycleHooks/hooks.js';
import { type IDESelection, useIdeSelection } from 'src/platform/ide/useIdeSelection.js';
import { getTools } from 'src/tools/tools.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { resolveAgentTools } from 'src/tools/AgentTool/agentToolUtils.js';
import { resumeAgentBackground } from 'src/tools/AgentTool/resumeAgent.js';
import { useMainLoopModel } from 'src/agent/hooks/useMainLoopModel.js';
import { useAppState, useSetAppState, useAppStateStore } from 'src/terminal/state/AppState.js';
import { useContainerStatus } from 'src/containers/hooks/useContainerStatus.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import type { PastedContent } from 'src/platform/config/config.js';
import { copyPlanForFork, copyPlanForResume, getPlanSlug, setPlanSlug } from 'src/agent/plans/plans.js';
import { clearSessionMetadata, resetSessionFilePointer, adoptResumedSessionFile, restoreSessionMetadata, getCurrentSessionTitle, isLoggableMessage, saveWorktreeState, getAgentTranscript } from 'src/sessions/sessionStorage.js';
import { deserializeMessages } from 'src/sessions/conversationRecovery.js';
import { extractReadFilesFromMessages, extractBashToolsFromMessages } from 'src/agent/queryHelpers.js';
import { runPostCompactCleanup } from 'src/agent/compact/postCompactCleanup.js';
import { applyToolResultReplacementsToMessages, provisionContentReplacementState, reconstructContentReplacementState, type ContentReplacementRecord } from 'src/agent/tools/toolResultStorage.js';
import { partialCompactConversation } from 'src/agent/compact/compact.js';
import type { LogOption } from 'src/shared/types/logs.js';
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js';
import { fileHistoryMakeSnapshot, type FileHistoryState, fileHistoryRewind, type FileHistorySnapshot, copyFileHistoryForResume, fileHistoryEnabled } from 'src/shared/fs/fileHistory.js';
import { computeStandaloneAgentContext, restoreAgentFromSession, restoreSessionStateFromLog, restoreWorktreeForResume, exitRestoredWorktree } from 'src/sessions/sessionRestore.js';
import { updateSessionName } from 'src/sessions/concurrentSessions.js';
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from 'src/agent/tasks/InProcessTeammateTask/types.js';
import { restoreRemoteAgentTasks } from 'src/agent/tasks/RemoteAgentTask/RemoteAgentTask.js';
import { useInboxPoller } from 'src/terminal/voice/useInboxPoller.js';
// Dead code elimination: conditional import for loop mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../../platform/proactive/index.js') : null;
const PROACTIVE_NO_OP_SUBSCRIBE = (_cb: () => void) => () => { };
const PROACTIVE_FALSE = () => false;
const SUGGEST_BG_PR_NOOP = (_p: string, _n: string): boolean => false;
const useProactive = feature('PROACTIVE') || feature('KAIROS') ? require('../../platform/proactive/useProactive.js').useProactive : null;
const useScheduledTasks = require('src/agent/hooks/useScheduledTasks.js').useScheduledTasks;
/* eslint-enable @typescript-eslint/no-require-imports */
import { isAgentSwarmsEnabled } from 'src/agent/coordinator/agentSwarmsEnabled.js';
import { useTaskListWatcher } from 'src/agent/hooks/useTaskListWatcher.js';
import type { NetworkHostPattern } from 'src/platform/sandbox/sandbox-adapter.js';
import { type IDEExtensionInstallationStatus, type IdeType } from 'src/platform/ide/ide.js';
import { useIDEIntegration } from 'src/platform/ide/useIDEIntegration.js';
import { getCurrentWorktreeSession } from 'src/vcs/git/worktree.js';
import { popAllEditable, getCommandQueue, getCommandQueueLength } from 'src/agent/messageQueueManager.js';
import { bindToolJSXStore, dispatchToolJSX, getCurrentLocalJSXGeneration } from 'src/terminal/toolJSXStore.js';
import { useCommandQueue } from 'src/agent/hooks/useCommandQueue.js';
import { SessionBackgroundHint } from 'src/sessions/ui/SessionBackgroundHint.js';
import { useSessionBackgrounding } from 'src/sessions/hooks/useSessionBackgrounding.js';
import { diagnosticTracker } from 'src/platform/diagnosticTracking.js';
import { handleSpeculationAccept } from 'src/terminal/prompt-suggestion/speculation.js';
import { IdeOnboardingDialog } from 'src/platform/ide/IdeOnboardingDialog.js';
import { EffortCallout, shouldShowEffortCallout } from 'src/providers/ui/EffortCallout.js';
import { RemoteCallout } from 'src/platform/remote/RemoteCallout.js';
import { getAPIProvider } from 'src/providers/model/providers.js';
const AntModelSwitchCallout = null;
const shouldShowAntModelSwitch = (): boolean => false;
import { activityManager } from 'src/agent/coordinator/activityManager.js';
import { createAbortController } from 'src/shared/abortController.js';
import { MCPConnectionManager } from 'src/mcp/MCPConnectionManager.js';
import { useFeedbackSurvey } from 'src/platform/feedback/useFeedbackSurvey.js';
import { useMemorySurvey } from 'src/platform/feedback/useMemorySurvey.js';
import { usePostCompactSurvey } from 'src/platform/feedback/usePostCompactSurvey.js';
import { FeedbackSurvey } from 'src/platform/feedback/FeedbackSurvey.js';
import type { TranscriptShareResponse } from 'src/platform/feedback/TranscriptSharePrompt.js';
import { useInstallMessages } from 'src/platform/notifications/useInstallMessages.js';
import { useAwaySummary } from 'src/agent/hooks/useAwaySummary.js';
import { useOfficialMarketplaceNotification } from 'src/platform/useOfficialMarketplaceNotification.js';
import { getTipToShowOnSpinner, recordShownTip } from 'src/terminal/tips/tipScheduler.js';
import type { Theme } from 'src/terminal/theme/theme.js';
import { isPromptTypingSuppressionActive } from 'src/agent/repl/replInputSuppression.js';
import { shouldRunStartupChecks } from 'src/agent/repl/replStartupGates.js';
import { useKickOffCheckAndDisableBypassPermissionsIfNeeded, useKickOffCheckAndDisableAutoModeIfNeeded } from 'src/permissions/bypassPermissionsKillswitch.js';
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js';
import { useFileHistorySnapshotInit } from 'src/sessions/hooks/useFileHistorySnapshotInit.js';
import { SandboxPermissionRequest } from 'src/permissions/ui/SandboxPermissionRequest.js';
import { SandboxViolationExpandedView } from 'src/permissions/ui/SandboxViolationExpandedView.js';
import { useSettingsErrors } from 'src/platform/notifications/useSettingsErrors.js';
import { useMcpConnectivityStatus } from 'src/platform/notifications/useMcpConnectivityStatus.js';
import { useAutoModeUnavailableNotification } from 'src/platform/notifications/useAutoModeUnavailableNotification.js';
import { AUTO_MODE_DESCRIPTION } from 'src/permissions/ui/AutoModeOptInDialog.js';
import { useLspInitializationNotification } from 'src/platform/notifications/useLspInitializationNotification.js';
import { useClaudeCodeHintRecommendation } from 'src/platform/useClaudeCodeHintRecommendation.js';
import { PluginHintMenu } from 'src/platform/hints/PluginHintMenu.js';
import { DesktopUpsellStartup, shouldShowDesktopUpsellStartup } from 'src/platform/billing/desktop-upsell/DesktopUpsellStartup.js';
import { usePluginInstallationStatus } from 'src/platform/notifications/usePluginInstallationStatus.js';
import { usePluginAutoupdateNotification } from 'src/platform/notifications/usePluginAutoupdateNotification.js';
import { performStartupChecks } from 'src/plugins/performStartupChecks.js';
import { UserTextMessage } from 'src/agent/ui/messages/UserTextMessage.js';
import { AwsAuthStatusBox } from 'src/providers/ui/AwsAuthStatusBox.js';
import { useRateLimitWarningNotification } from 'src/platform/notifications/useRateLimitWarningNotification.js';
import { useDeprecationWarningNotification } from 'src/platform/notifications/useDeprecationWarningNotification.js';
import { useNpmDeprecationNotification } from 'src/platform/notifications/useNpmDeprecationNotification.js';
import { useIDEStatusIndicator } from 'src/platform/notifications/useIDEStatusIndicator.js';
import { useModelMigrationNotifications } from 'src/platform/notifications/useModelMigrationNotifications.js';
import { useCanSwitchToExistingSubscription } from 'src/platform/notifications/useCanSwitchToExistingSubscription.js';
import { useTeammateLifecycleNotification } from 'src/platform/notifications/useTeammateShutdownNotification.js';
import { useFastModeNotification } from 'src/platform/notifications/useFastModeNotification.js';
import { AutoRunIssueNotification, shouldAutoRunIssue, getAutoRunIssueReasonText, getAutoRunCommand, type AutoRunIssueReason } from 'src/agent/ui/autoRunIssue.js';
import type { HookProgress } from 'src/shared/types/hooks.js';
import { TungstenLiveMonitor } from 'src/tools/TungstenTool/TungstenLiveMonitor.js';
/* eslint-disable @typescript-eslint/no-require-imports */
const WebBrowserPanelModule = feature('WEB_BROWSER_TOOL') ? require('../../tools/WebBrowserTool/WebBrowserPanel.js') as typeof import('../../tools/WebBrowserTool/WebBrowserPanel.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { IssueFlagBanner } from 'src/terminal/prompt-input/IssueFlagBanner.js';
import { useIssueFlagBanner } from 'src/platform/useIssueFlagBanner.js';
import { CompanionSprite, CompanionFloatingBubble, MIN_COLS_FOR_FULL_SPRITE } from 'src/terminal/buddy/CompanionSprite.js';
import { isBuddyEnabled } from 'src/terminal/buddy/feature.js';
// Session manager removed - using AppState now
import type { RemoteSessionConfig } from 'src/platform/remote/RemoteSessionManager.js';
import { REMOTE_SAFE_COMMANDS } from 'src/commands/commands.js';
import { FullscreenLayout, useUnseenDivider, computeUnseenDivider } from 'src/terminal/FullscreenLayout.js';
import { StartupBanner } from 'src/platform/StartupBanner.js';
import { isFullscreenEnvEnabled, maybeGetTmuxMouseHint, isMouseTrackingEnabled } from 'src/terminal/render/fullscreen.js';
import { AlternateScreen } from 'src/terminal/ink/components/AlternateScreen.js';
import { ScrollKeybindingHandler } from 'src/terminal/ScrollKeybindingHandler.js';
import { useMessageActions, MessageActionsKeybindings, MessageActionsBar, type MessageActionsState, type MessageActionsNav } from 'src/agent/ui/messageActions.js';
import type { ScrollBoxHandle } from 'src/terminal/ink/components/ScrollBox.js';

// Stable empty array for hooks that accept MCPServerConnection[] — avoids
// creating a new [] literal on every render in remote mode, which would
// cause useEffect dependency changes and infinite re-render loops.
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = [];

// Stable stub for useAssistantHistory's non-KAIROS branch — avoids a new
// function identity each render, which would break composedOnScroll's memo.
const HISTORY_STUB = {
  maybeLoadOlder: (_: ScrollBoxHandle) => { }
};
// Window after a user-initiated scroll during which type-into-empty does NOT
// repin to bottom. Josh Rosen's workflow: Claude emits long output → scroll
// up to read the start → start typing → before this fix, snapped to bottom.
// https://anthropic.slack.com/archives/C07VBSHV7EV/p1773545449871739
const RECENT_SCROLL_REPIN_WINDOW_MS = 3000;

// Most recent messages the Ink tree mounts. A render window, not a history
// bound: the state array behind it is never cut (see displayedMessages).
const MAX_DISPLAY_MESSAGES = 200;

// Use LRU cache to prevent unbounded memory growth
// 100 files should be sufficient for most coding sessions while preventing
// memory issues when working across many files in large projects

// `median`, `TranscriptModeFooter`, `TranscriptSearchBar`,
// `AnimatedTerminalTitle` and the `TITLE_*` constants were extracted
// in Etapa 1 of ROADMAP 11e. See:
//   src/agent/repl/utils/math.ts
//   src/agent/repl/components/TranscriptModeFooter.tsx
//   src/agent/repl/components/TranscriptSearchBar.tsx
//   src/agent/repl/components/AnimatedTerminalTitle.tsx
//
// The controllers ROADMAP 11e deferred ("REPL.tsx mantém controllers
// (`onSubmit`/`onQuery*`) e composição") now live in
// src/agent/repl/controllers/. Each is a custom hook invoked from exactly the
// position its original declaration occupied, so the component's hook-call
// sequence is unchanged (verified: 301 hook calls, identical order, before and
// after). See:
//   src/agent/repl/controllers/useSandboxAsk.ts
//   src/agent/repl/controllers/useToolUseContext.ts
//   src/agent/repl/controllers/useOnQuery.ts
//   src/agent/repl/controllers/useOnSubmit.ts
//   src/agent/repl/controllers/useMessageActionsController.ts
//
// What deliberately stayed here: the JSX composition (`mainReturn`), the
// initial-message effect (it sits BETWEEN useOnQuery and useOnSubmit and closes
// over both), `onCancel`/`cancelRequestProps`, `executeQueuedInput` (28 lines,
// pure passthrough to handlePromptSubmit) and `onAgentSubmit`.

export type Props = {
  commands: Command[];
  debug: boolean;
  initialTools: Tool[];
  // Initial messages to populate the REPL with
  initialMessages?: MessageType[];
  // Deferred hook messages promise — REPL renders immediately and injects
  // hook messages when they resolve. Awaited before the first API call.
  pendingHookMessages?: Promise<HookResultMessage[]>;
  initialFileHistorySnapshots?: FileHistorySnapshot[];
  // Content-replacement records from a resumed session's transcript — used to
  // reconstruct contentReplacementState so the same results are re-replaced
  initialContentReplacements?: ContentReplacementRecord[];
  // Initial agent context for session resume (name/color set via /rename or /color)
  initialAgentName?: string;
  initialAgentColor?: AgentColorName;
  mcpClients?: MCPServerConnection[];
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  autoConnectIdeFlag?: boolean;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  // Optional callback invoked before query execution
  // Called after user message is added to conversation but before API call
  // Return false to prevent query execution
  onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>;
  // Optional callback when a turn completes (model finishes responding)
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>;
  // When true, disables REPL input (hides prompt and prevents message selector)
  disabled?: boolean;
  // Optional agent definition to use for the main thread
  mainThreadAgentDefinition?: AgentDefinition;
  // When true, disables all slash commands
  disableSlashCommands?: boolean;
  // Task list id: when set, enables tasks mode that watches a task list and auto-processes tasks.
  taskListId?: string;
  // Remote session config for --remote mode (uses CCR as execution engine)
  remoteSessionConfig?: RemoteSessionConfig;
  // Direct connect config for `claude connect` mode (connects to a claude server)
  directConnectConfig?: DirectConnectConfig;
  // SSH session for `claude ssh` mode (local REPL, remote tools over ssh)
  sshSession?: SSHSession;
  // Thinking configuration to use when thinking is enabled
  thinkingConfig: ThinkingConfig;
};
export type Screen = 'prompt' | 'transcript';
export function REPL({
  commands: initialCommands,
  debug,
  initialTools,
  initialMessages,
  pendingHookMessages,
  initialFileHistorySnapshots,
  initialContentReplacements,
  initialAgentName,
  initialAgentColor,
  mcpClients: initialMcpClients,
  dynamicMcpConfig: initialDynamicMcpConfig,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt: customSystemPrompt,
  appendSystemPrompt,
  onBeforeQuery,
  onTurnComplete,
  disabled = false,
  mainThreadAgentDefinition: initialMainThreadAgentDefinition,
  disableSlashCommands = false,
  taskListId,
  remoteSessionConfig,
  directConnectConfig,
  sshSession,
  thinkingConfig
}: Props): React.ReactNode {
  // Wave 6 audit — repl_first_paint fires exactly once on initial mount.
  // Module-level guard avoids React StrictMode double-invoke. This is the
  // earliest reliable signal that the user is looking at REPL UI; everything
  // up to this point is "loading" wall-clock from the user's perspective.
  if (!_replFirstPaintMarked) {
    _replFirstPaintMarked = true;
    profileCheckpoint('repl_first_paint');
  }
  const isRemoteSession = !!remoteSessionConfig;

  // Wire up Ctrl+C / Ctrl+D double-press to exit. Ink raw mode disables ISIG,
  // so the OS-level SIGINT handler in main.tsx never fires while the TUI is
  // mounted. Without this hook, idle Ctrl+C at the prompt is silently
  // swallowed (CancelRequestHandler intentionally only claims it during a
  // running task). The hook also drives the "Press Ctrl-C again to exit" hint.
  //
  // Both PromptInput's TextInput (via useTextInput's own useDoublePress) and
  // this hook see the same Ctrl+C event. Route both through handleExit so the
  // worktree/bg-session paths run; the exit state machine inside handleExit
  // collapses the two concurrent calls (both transition idle → requested in
  // the same tick, the second is observed as 'requested' and forces SIGKILL —
  // which is the desired behavior on a true second press).
  const handleExitRef = useRef<() => void>(() => {});
  useExitOnCtrlCDWithKeybindings(() => { handleExitRef.current(); });

  // Env-var gates hoisted to mount-time — isEnvTruthy does toLowerCase+trim+
  // includes, and these were on the render path (hot during PageUp spam).
  const titleDisabled = useMemo(() => isEnvTruthy(process.env.CLAUDIN_DISABLE_TERMINAL_TITLE), []);
  const moreRightEnabled = useMemo(() => false, []);
  const disableVirtualScroll = useMemo(() => isEnvTruthy(process.env.CLAUDIN_DISABLE_VIRTUAL_SCROLL), []);
  const disableMessageActions = feature('MESSAGE_ACTIONS') ?
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useMemo(() => isEnvTruthy(process.env.CLAUDIN_DISABLE_MESSAGE_ACTIONS), []) : false;

  // Agent definition is state so /resume can update it mid-session
  const [mainThreadAgentDefinition, setMainThreadAgentDefinition] = useState(initialMainThreadAgentDefinition);
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const verbose = useAppState(s => s.verbose);
  const mcp = useAppState(s => s.mcp);
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const fileHistory = useAppState(s => s.fileHistory);
  const initialMessage = useAppState(s => s.initialMessage);
  const queuedCommands = useCommandQueue();
  // feature() is a build-time constant — dead code elimination removes the hook
  // call entirely in external builds, so this is safe despite looking conditional.
  // These fields contain excluded strings that must not appear in external builds.
  const spinnerTip = useAppState(s => s.spinnerTip);
  const showExpandedTodos = useAppState(s => s.expandedView) === 'tasks';
  const pendingWorkerRequest = useAppState(s => s.pendingWorkerRequest);
  const pendingSandboxRequest = useAppState(s => s.pendingSandboxRequest);
  const teamContext = useAppState(s => s.teamContext);
  const tasks = useAppState(s => s.tasks);
  const workerSandboxPermissions = useAppState(s => s.workerSandboxPermissions);
  const elicitation = useAppState(s => s.elicitation);
  const ultraplanPendingChoice = useAppState(s => s.ultraplanPendingChoice);
  const ultraplanLaunchPending = useAppState(s => s.ultraplanLaunchPending);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const setAppState = useSetAppState();

  // Bootstrap: retained local_agent that hasn't loaded disk yet → read
  // sidechain JSONL and UUID-merge with whatever stream has appended so far.
  // Stream appends immediately on retain (no defer); bootstrap fills the
  // prefix. Disk-write-before-yield means live is always a suffix of disk.
  const viewedLocalAgent = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const needsBootstrap = isLocalAgentTask(viewedLocalAgent) && viewedLocalAgent.retain && !viewedLocalAgent.diskLoaded;
  useEffect(() => {
    if (!viewingAgentTaskId || !needsBootstrap) return;
    const taskId = viewingAgentTaskId;
    void getAgentTranscript(asAgentId(taskId)).then(result => {
      setAppState(prev => {
        const t = prev.tasks[taskId];
        if (!isLocalAgentTask(t) || t.diskLoaded || !t.retain) return prev;
        const live = t.messages ?? [];
        const liveUuids = new Set(live.map(m => m.uuid));
        const diskOnly = result ? result.messages.filter(m => !liveUuids.has(m.uuid)) : [];
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...t,
              messages: [...diskOnly, ...live],
              diskLoaded: true
            }
          }
        };
      });
    });
  }, [viewingAgentTaskId, needsBootstrap, setAppState]);
  const store = useAppStateStore();
  const terminal = useTerminalNotification();
  const mainLoopModel = useMainLoopModel();
  // Watches docker for this project and keeps the footer's `containers` group
  // in AppState. Mounted here rather than in the footer because the watcher
  // owns a long-lived child process — a component that unmounts and remounts
  // would respawn `docker events` each time.
  useContainerStatus();

  // Note: standaloneAgentContext is initialized in main.tsx (via initialState) or
  // ResumeConversation.tsx (via setAppState before rendering REPL) to avoid
  // useEffect-based state initialization on mount (per CLAUDE.md guidelines)

  // Local state for commands (hot-reloadable when skill files change)
  const [localCommands, setLocalCommands] = useState(initialCommands);

  // Watch for skill file changes and reload all commands
  useSkillsChange(isRemoteSession ? undefined : getProjectRoot(), setLocalCommands);

  // Track proactive mode for tools dependency - SleepTool filters by proactive state
  const proactiveActive = React.useSyncExternalStore(proactiveModule?.subscribeToProactiveChanges ?? PROACTIVE_NO_OP_SUBSCRIBE, proactiveModule?.isProactiveActive ?? PROACTIVE_FALSE);

  // BriefTool.isEnabled() reads getUserMsgOptIn() from bootstrap state, which
  // /brief flips mid-session alongside isBriefOnly. The memo below needs a
  // React-visible dep to re-run getTools() when that happens; isBriefOnly is
  // the AppState mirror that triggers the re-render. Without this, toggling
  // /brief mid-session leaves the stale tool list (no SendUserMessage) and
  // the model emits plain text the brief filter hides.
  const isBriefOnly = useAppState(s => s.isBriefOnly);
  const localTools = useMemo(() => getTools(toolPermissionContext), [toolPermissionContext, proactiveActive, isBriefOnly]);
  useKickOffCheckAndDisableBypassPermissionsIfNeeded();
  useKickOffCheckAndDisableAutoModeIfNeeded();
  const [dynamicMcpConfig, setDynamicMcpConfig] = useState<Record<string, ScopedMcpServerConfig> | undefined>(initialDynamicMcpConfig);
  const onChangeDynamicMcpConfig = useCallback((config: Record<string, ScopedMcpServerConfig>) => {
    setDynamicMcpConfig(config);
  }, [setDynamicMcpConfig]);
  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  // [ forces the dump-to-scrollback path inside transcript mode. Separate
  // from CLAUDIN_NO_FLICKER=0 (which is process-lifetime) — this is
  // ephemeral, reset on transcript exit. Diagnostic escape hatch so
  // terminal/tmux native cmd-F can search the full flat render.
  const [dumpMode, setDumpMode] = useState(false);
  // v-for-editor render progress. Inline in the footer — notifications
  // render inside PromptInput which isn't mounted in transcript.
  const [editorStatus, setEditorStatus] = useState('');
  // Incremented on transcript exit. Async v-render captures this at start;
  // each status write no-ops if stale (user left transcript mid-render —
  // the stable setState would otherwise stamp a ghost toast into the next
  // session). Also clears any pending 4s auto-clear.
  const editorGenRef = useRef(0);
  const editorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editorRenderingRef = useRef(false);
  const {
    addNotification,
    removeNotification
  } = useNotifications();

  // eslint-disable-next-line prefer-const
  let trySuggestBgPRIntercept = SUGGEST_BG_PR_NOOP;
  const mcpClients = useMergedClients(initialMcpClients, mcp.clients);

  // IDE integration
  const [ideSelection, setIDESelection] = useState<IDESelection | undefined>(undefined);
  const [ideToInstallExtension, setIDEToInstallExtension] = useState<IdeType | null>(null);
  const [ideInstallationStatus, setIDEInstallationStatus] = useState<IDEExtensionInstallationStatus | null>(null);
  const [showIdeOnboarding, setShowIdeOnboarding] = useState(false);
  const [showModelSwitchCallout, setShowModelSwitchCallout] = useState(() => false);
  const [showEffortCallout, setShowEffortCallout] = useState(() => shouldShowEffortCallout(mainLoopModel));
  const showRemoteCallout = useAppState(s => s.showRemoteCallout);
  const [showDesktopUpsellStartup, setShowDesktopUpsellStartup] = useState(() => shouldShowDesktopUpsellStartup());
  // notifications
  useModelMigrationNotifications();
  useCanSwitchToExistingSubscription();
  useIDEStatusIndicator({
    ideSelection,
    mcpClients,
    ideInstallationStatus
  });
  useMcpConnectivityStatus({
    mcpClients
  });
  useAutoModeUnavailableNotification();
  usePluginInstallationStatus();
  usePluginAutoupdateNotification();
  useSettingsErrors();
  useRateLimitWarningNotification(mainLoopModel);
  useFastModeNotification();
  useDeprecationWarningNotification(mainLoopModel);
  useNpmDeprecationNotification();
  useAntOrgWarningNotification();
  useInstallMessages();
  useOfficialMarketplaceNotification();
  useLspInitializationNotification();
  useTeammateLifecycleNotification();
  const {
    recommendation: hintRecommendation,
    handleResponse: handleHintResponse
  } = useClaudeCodeHintRecommendation();

  // Memoize the combined initial tools array to prevent reference changes
  const combinedInitialTools = useMemo(() => {
    return [...localTools, ...initialTools];
  }, [localTools, initialTools]);

  // Initialize plugin management
  const pluginCommands = useManagePlugins({
    enabled: !isRemoteSession
  });
  const tasksV2 = useTasksV2WithCollapseEffect();

  // Start background plugin installations

  // SECURITY: This code is guaranteed to run ONLY after the "trust this folder" dialog
  // has been confirmed by the user. The trust dialog is shown in cli.tsx (line ~387)
  // before the REPL component is rendered. The dialog blocks execution until the user
  // accepts, and only then is the REPL component mounted and this effect runs.
  // This ensures that plugin installations from repository and user settings only
  // happen after explicit user consent to trust the current working directory.
  // Deferring startup checks is handled below (after promptTypingSuppressionActive
  // is declared) to avoid temporal dead zone issues.

  // Initialize swarm features: teammate hooks and context
  // Handles both fresh spawns and resumed teammate sessions
  useSwarmInitialization(setAppState, initialMessages, {
    enabled: !isRemoteSession
  });
  const mergedTools = useMergedTools(combinedInitialTools, mcp.tools, toolPermissionContext);

  // Apply agent tool restrictions if mainThreadAgentDefinition is set
  const {
    tools,
    allowedAgentTypes
  } = useMemo(() => {
    if (!mainThreadAgentDefinition) {
      return {
        tools: mergedTools,
        allowedAgentTypes: undefined as string[] | undefined
      };
    }
    const resolved = resolveAgentTools(mainThreadAgentDefinition, mergedTools, false, true);
    return {
      tools: resolved.resolvedTools,
      allowedAgentTypes: resolved.allowedAgentTypes
    };
  }, [mainThreadAgentDefinition, mergedTools]);

  // Merge commands from local state, plugins, and MCP
  const commandsWithPlugins = useMergedCommands(localCommands, pluginCommands as Command[]);
  const mergedCommands = useMergedCommands(commandsWithPlugins, mcp.commands as Command[]);
  // Keep plugin commands out of render-time command props. Feeding the full
  // execution set into PromptInput/Messages reintroduced the startup repaint
  // freeze, while transcript rendering still round-trips plugin skills via the
  // SkillTool's `skill` payload without needing plugin command objects here.
  const renderMergedCommands = useMergedCommands(localCommands, mcp.commands as Command[]);
  // Filter out all commands if disableSlashCommands is true
  const commands = useMemo(() => disableSlashCommands ? [] : mergedCommands, [disableSlashCommands, mergedCommands]);
  const renderCommands = useMemo(() => disableSlashCommands ? [] : renderMergedCommands, [disableSlashCommands, renderMergedCommands]);
  useIdeLogging(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients);
  useIdeSelection(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients, setIDESelection);
  const [streamMode, setStreamMode] = useState<SpinnerMode>('responding');
  // Ref mirror so onSubmit can read the latest value without adding
  // streamMode to its deps. streamMode flips between
  // requesting/responding/tool-use ~10x per turn during streaming; having it
  // in onSubmit's deps was recreating onSubmit on every flip, which
  // cascaded into PromptInput prop churn and downstream useCallback/useMemo
  // invalidation. The only consumers inside callbacks are debug logging and
  // telemetry (handlePromptSubmit.ts), so a stale-by-one-render value is
  // harmless — but ref mirrors sync on every render anyway so it's fresh.
  const streamModeRef = useRef(streamMode);
  streamModeRef.current = streamMode;
  const [streamingToolUses, setStreamingToolUses] = useState<StreamingToolUse[]>([]);
  // Coalesces per-chunk input_json_delta updates from the local stream path
  // (onQueryEvent) to one commit per frame interval — tool-input streaming
  // (large Edit/Write inputs) is otherwise the chattiest setState in the
  // tree. Direct setters below bypass it (cancel first); the remote-session
  // path keeps the raw setter. useState setters are identity-stable, so the
  // updater can be created once.
  const coalescedStreamingToolUses = useMemo(() => createCoalescedUpdater<StreamingToolUse[]>(setStreamingToolUses), []);
  const [streamingThinking, setStreamingThinking] = useState<StreamingThinking | null>(null);

  // Auto-hide streaming thinking after 30 seconds of being completed
  useEffect(() => {
    if (streamingThinking && !streamingThinking.isStreaming && streamingThinking.streamingEndedAt) {
      const elapsed = Date.now() - streamingThinking.streamingEndedAt;
      const remaining = 30000 - elapsed;
      if (remaining > 0) {
        const timer = setTimeout(setStreamingThinking, remaining, null);
        return () => clearTimeout(timer);
      } else {
        setStreamingThinking(null);
      }
    }
  }, [streamingThinking]);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  // Ref that always points to the current abort controller, used by the
  // REPL bridge to abort the active query when a remote interrupt arrives.
  const abortControllerRef = useRef<AbortController | null>(null);
  abortControllerRef.current = abortController;

  // Ref for the bridge result callback — set after useReplBridge initializes,
  // read in the onQuery finally block to notify mobile clients that a turn ended.
  const sendBridgeResultRef = useRef<() => void>(() => { });

  // Ref for the synchronous restore callback — set after restoreMessageSync is
  // defined, read in the onQuery finally block for auto-restore on interrupt.
  const restoreMessageSyncRef = useRef<(m: UserMessage) => void>(() => { });

  // Ref to the fullscreen layout's scroll box for keyboard scrolling.
  // Null when fullscreen mode is disabled (ref never attached).
  const scrollRef = useRef<ScrollBoxHandle>(null);
  // Separate ref for the modal slot's inner ScrollBox — passed through
  // FullscreenLayout → ModalContext so Tabs can attach it to its own
  // ScrollBox for tall content (e.g. /status's MCP-server list). NOT
  // keyboard-driven — ScrollKeybindingHandler stays on the outer ref so
  // PgUp/PgDn/wheel always scroll the transcript behind the modal.
  // Plumbing kept for future modal-scroll wiring.
  const modalScrollRef = useRef<ScrollBoxHandle>(null);
  // Timestamp of the last user-initiated scroll (wheel, PgUp/PgDn, ctrl+u,
  // End/Home, G, drag-to-scroll). Stamped in composedOnScroll — the single
  // chokepoint ScrollKeybindingHandler calls for every user scroll action.
  // Programmatic scrolls (repinScroll's scrollToBottom, sticky auto-follow)
  // do NOT go through composedOnScroll, so they don't stamp this. Ref not
  // state: no re-render on every wheel tick.
  const lastUserScrollTsRef = useRef(0);

  // Synchronous state machine for the query lifecycle. Replaces the
  // error-prone dual-state pattern where isLoading (React state, async
  // batched) and isQueryRunning (ref, sync) could desync. See QueryGuard.ts.
  const queryGuard = React.useRef(new QueryGuard()).current;

  // Subscribe to the guard — true during dispatching or running.
  // This is the single source of truth for "is a local query in flight".
  const isQueryActive = React.useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot);

  // Separate loading flag for operations outside the local query guard:
  // remote sessions (useRemoteSession / useDirectConnect) and foregrounded
  // background tasks (useSessionBackgrounding). These don't route through
  // onQuery / queryGuard, so they need their own spinner-visibility state.
  // Initialize true if remote mode with initial prompt (CCR processing it).
  const [isExternalLoading, setIsExternalLoadingRaw] = React.useState(remoteSessionConfig?.hasInitialPrompt ?? false);

  // Derived: any loading source active. Read-only — no setter. Local query
  // loading is driven by queryGuard (reserve/tryStart/end/cancelReservation),
  // external loading by setIsExternalLoading.
  const isLoading = isQueryActive || isExternalLoading;

  // Elapsed time is computed by SpinnerWithVerb from these refs on each
  // animation frame, avoiding a useInterval that re-renders the entire REPL.
  const [userInputOnProcessing, setUserInputOnProcessingRaw] = React.useState<string | undefined>(undefined);
  // messagesRef.current.length at the moment userInputOnProcessing was set.
  // The placeholder hides once displayedMessages grows past this — i.e. the
  // real user message has landed in the visible transcript.
  const userInputBaselineRef = React.useRef(0);
  // True while the submitted prompt is being processed but its user message
  // hasn't reached setMessages yet. setMessages uses this to keep the
  // baseline in sync when unrelated async messages (bridge status, hook
  // results, scheduled tasks) land during that window.
  const userMessagePendingRef = React.useRef(false);

  // Wall-clock time tracking refs for accurate elapsed time calculation
  const loadingStartTimeRef = React.useRef<number>(0);
  const totalPausedMsRef = React.useRef(0);
  const pauseStartTimeRef = React.useRef<number | null>(null);
  const resetTimingRefs = React.useCallback(() => {
    loadingStartTimeRef.current = Date.now();
    totalPausedMsRef.current = 0;
    pauseStartTimeRef.current = null;
  }, []);

  // Reset timing refs inline when isQueryActive transitions false→true.
  // queryGuard.reserve() (in executeUserInput) fires BEFORE processUserInput's
  // first await, but the ref reset in onQuery's try block runs AFTER. During
  // that gap, React renders the spinner with loadingStartTimeRef=0, computing
  // elapsedTimeMs = Date.now() - 0 ≈ 56 years. This inline reset runs on the
  // first render where isQueryActive is observed true — the same render that
  // first shows the spinner — so the ref is correct by the time the spinner
  // reads it. See INC-4549.
  const wasQueryActiveRef = React.useRef(false);
  if (isQueryActive && !wasQueryActiveRef.current) {
    resetTimingRefs();
  }
  wasQueryActiveRef.current = isQueryActive;

  // Wrapper for setIsExternalLoading that resets timing refs on transition
  // to true — SpinnerWithVerb reads these for elapsed time, so they must be
  // reset for remote sessions / foregrounded tasks too (not just local
  // queries, which reset them in onQuery). Without this, a remote-only
  // session would show ~56 years elapsed (Date.now() - 0).
  const setIsExternalLoading = React.useCallback((value: boolean) => {
    setIsExternalLoadingRaw(value);
    if (value) resetTimingRefs();
  }, [resetTimingRefs]);

  // Start time of the first turn that had swarm teammates running
  // Used to compute total elapsed time (including teammate execution) for the deferred message
  const swarmStartTimeRef = React.useRef<number | null>(null);
  const swarmBudgetInfoRef = React.useRef<{
    tokens: number;
    limit: number;
    nudges: number;
  } | undefined>(undefined);

  // Ref to track current focusedInputDialog for use in callbacks
  // This avoids stale closures when checking dialog state in timer callbacks
  const focusedInputDialogRef = React.useRef<ReturnType<typeof getFocusedInputDialog>>(undefined);

  // How long after the last keystroke before deferred dialogs are shown
  const PROMPT_SUPPRESSION_MS = 1500;
  // True when user is actively typing — defers interrupt dialogs so keystrokes
  // don't accidentally dismiss or answer a permission prompt the user hasn't read yet.
  const [isPromptInputActive, setIsPromptInputActive] = React.useState(false);
  // Auto-updaters were removed in favor of the startup-banner "new version
  // available" notice + manual `claudin update`. The PromptInput/Notifications
  // tree still expects these props (React-compiler memoization makes them
  // awkward to remove cleanly), so keep them as inert constants.
  const autoUpdaterResult = null;
  const setAutoUpdaterResult = React.useCallback(() => {}, []);

  // tmux + fullscreen + `mouse off`: one-time hint that wheel won't scroll.
  // We no longer mutate tmux's session-scoped mouse option (it poisoned
  // sibling panes); tmux users already know this tradeoff from vim/less.
  useEffect(() => {
    if (isFullscreenEnvEnabled()) {
      void maybeGetTmuxMouseHint().then(hint => {
        if (hint) {
          addNotification({
            key: 'tmux-mouse-hint',
            text: hint,
            priority: 'low'
          });
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [toolJSX, setToolJSXInternal] = useState<{
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand?: boolean;
    isImmediate?: boolean;
  } | null>(null);

  // toolJSXStore is a module singleton wrapping a pure reducer (see
  // src/terminal/setToolJSXReducer.ts). It exists so async call sites
  // (processSlashCommand, handlePromptSubmit) can capture a generation token
  // before they start awaiting, and have late writes from a stale chain
  // dropped automatically. Without this, a clearLocalJSX:true firing between
  // a slash command's await load() / await mod.call() / late setToolJSX
  // microtask would leave isLocalJSXCommand stuck true, blocking the queue
  // processor and locking out non-immediate slash commands like /clear.
  useEffect(() => bindToolJSXStore(setToolJSXInternal), []);

  // Wrapper for setToolJSX that dispatches into the singleton store.
  //
  // TO ADD A NEW IMMEDIATE COMMAND:
  // 1. Set `immediate: true` in the command definition
  // 2. Set `isLocalJSXCommand: true` when calling setToolJSX in the command's JSX
  // 3. In the onDone callback, use `setToolJSX({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true })`
  //    to explicitly clear the overlay when the user dismisses it
  // 4. For async callers that await before calling setToolJSX with
  //    isLocalJSXCommand:true, capture getCurrentLocalJSXGeneration() BEFORE
  //    the first await and pass it back as `generation` — protects against
  //    stale-write races.
  const setToolJSX = useCallback((args: {
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand?: boolean;
    isImmediate?: boolean;
    clearLocalJSX?: boolean;
    generation?: number;
  } | null) => {
    if (args == null) {
      dispatchToolJSX({ type: 'set_null' });
      return;
    }
    if (args.clearLocalJSX) {
      dispatchToolJSX({ type: 'clear_local_jsx' });
      return;
    }
    const { clearLocalJSX: _c, generation, ...payload } = args;
    if (args.isLocalJSXCommand) {
      dispatchToolJSX({
        type: 'set_local_jsx',
        payload,
        generation: generation ?? Number.MAX_SAFE_INTEGER,
      });
      return;
    }
    dispatchToolJSX({ type: 'set_regular', payload });
  }, []);
  const [toolUseConfirmQueue, setToolUseConfirmQueue] = useState<ToolUseConfirm[]>([]);
  // Sticky footer JSX registered by permission request components (currently
  // only ExitPlanModePermissionRequest). Renders in FullscreenLayout's `bottom`
  // slot so response options stay visible while the user scrolls a long plan.
  const [permissionStickyFooter, setPermissionStickyFooter] = useState<React.ReactNode | null>(null);
  const [sandboxPermissionRequestQueue, setSandboxPermissionRequestQueue] = useState<Array<{
    hostPattern: NetworkHostPattern;
    resolvePromise: (allowConnection: boolean) => void;
  }>>([]);
  const [promptQueue, setPromptQueue] = useState<Array<{
    request: PromptRequest;
    title: string;
    toolInputSummary?: string | null;
    resolve: (response: PromptResponse) => void;
    reject: (error: Error) => void;
  }>>([]);

  // Track bridge cleanup functions for sandbox permission requests so the
  // local dialog handler can cancel the remote prompt when the local user
  // responds first. Keyed by host to support concurrent same-host requests.
  const sandboxBridgeCleanupRef = useRef<Map<string, Array<() => void>>>(new Map());

  // -- Terminal title management
  // Session title (set via /rename or restored on resume) wins over
  // the agent name, which wins over the Haiku-extracted topic;
  // all fall back to the product name.
  const terminalTitleFromRename = useAppState(s => s.settings.terminalTitleFromRename) !== false;
  const sessionTitle = terminalTitleFromRename ? getCurrentSessionTitle(getSessionId()) : undefined;
  const [haikuTitle, setHaikuTitle] = useState<string>();
  // Gates the one-shot Haiku call that generates the tab title. Seeded true
  // on resume (initialMessages present) so we don't re-title a resumed
  // session from mid-conversation context.
  const haikuTitleAttemptedRef = useRef((initialMessages?.length ?? 0) > 0);
  const agentTitle = mainThreadAgentDefinition?.agentType;
  const terminalTitle = sessionTitle ?? agentTitle ?? haikuTitle ?? 'Claudin';
  const isWaitingForApproval = toolUseConfirmQueue.length > 0 || promptQueue.length > 0 || pendingWorkerRequest !== null || pendingSandboxRequest !== null;
  // Local-jsx commands (like /plugin, /config) show user-facing dialogs that
  // wait for input. Require jsx != null — if the flag is stuck true but jsx
  // is null, treat as not-showing so TextInput focus and queue processor
  // aren't deadlocked by a phantom overlay.
  const isShowingLocalJSXCommand = toolJSX?.isLocalJSXCommand === true && toolJSX?.jsx != null;
  const titleIsAnimating = isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand;
  // Title animation state lives in <AnimatedTerminalTitle> so the 960ms tick
  // doesn't re-render REPL. titleDisabled/terminalTitle are still computed
  // here because onQueryImpl reads them (background session description,
  // haiku title extraction gate).

  // Boot/lifecycle effects: prevent-sleep + session-activity PID file push.
  // Both keyed on the same upstream loading/approval signals; consolidated in
  // a single hook so the `sessionStatus`/`waitingFor` derivation lives next to
  // its only consumer. See src/agent/repl/hooks/useReplLifecycle.ts.
  const { sessionStatus, waitingFor } = useReplLifecycle({
    isLoading,
    isWaitingForApproval,
    isShowingLocalJSXCommand,
    toolUseConfirmQueue,
    pendingWorkerRequest: pendingWorkerRequest !== null,
    pendingSandboxRequest: pendingSandboxRequest !== null,
  });

  // 3P default: off — OSC 21337 is internal-only while the spec stabilizes.
  // Gated so we can roll back if the sidebar indicator conflicts with
  // the title spinner in terminals that render both. When the flag is
  // on, the user-facing config setting controls whether it's active.
  const tabStatusGateEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_sidebar', false);
  const showStatusInTerminalTab = tabStatusGateEnabled && (getGlobalConfig().showStatusInTerminalTab ?? false);
  useTabStatus(titleDisabled || !showStatusInTerminalTab ? null : sessionStatus);

  // Register the leader's setToolUseConfirmQueue for in-process teammates
  useEffect(() => {
    registerLeaderToolUseConfirmQueue(setToolUseConfirmQueue);
    return () => unregisterLeaderToolUseConfirmQueue();
  }, [setToolUseConfirmQueue]);
  const [messages, rawSetMessages] = useState<MessageType[]>(() => {
    if (!initialMessages) return [];
    const initialReplacementState = provisionContentReplacementState(initialMessages, initialContentReplacements);
    return initialReplacementState ? applyToolResultReplacementsToMessages(initialMessages, initialReplacementState.replacements) : initialMessages;
  });
  const messagesRef = useRef(messages);
  // Stores the willowMode variant that was shown (or false if no hint shown).
  // Captured at hint_shown time so hint_converted telemetry reports the same
  // variant — the GrowthBook value shouldn't change mid-session, but reading
  // it once guarantees consistency between the paired events.
  const idleHintShownRef = useRef<string | false>(false);
  // Wrap setMessages so messagesRef is always current the instant the
  // call returns — not when React later processes the batch.  Apply the
  // updater eagerly against the ref, then hand React the computed value
  // (not the function).  rawSetMessages batching becomes last-write-wins,
  // and the last write is correct because each call composes against the
  // already-updated ref.  This is the Zustand pattern: ref is source of
  // truth, React state is the render projection.  Without this, paths
  // that queue functional updaters then synchronously read the ref
  // (e.g. handleSpeculationAccept → onQuery) see stale data.
  const setMessages = useCallback((action: React.SetStateAction<MessageType[]>) => {
    const prev = messagesRef.current;
    const next = typeof action === 'function' ? action(messagesRef.current) : action;
    messagesRef.current = next;
    if (next.length < userInputBaselineRef.current) {
      // Shrank (compact/rewind/clear) — clamp so placeholderText's length
      // check can't go stale.
      userInputBaselineRef.current = 0;
    } else if (next.length > prev.length && userMessagePendingRef.current) {
      // Grew while the submitted user message hasn't landed yet. If the
      // added messages don't include it (bridge status, hook results,
      // scheduled tasks landing async during processUserInputBase), bump
      // baseline so the placeholder stays visible. Once the user message
      // lands, stop tracking — later additions (assistant stream) should
      // not re-show the placeholder.
      const delta = next.length - prev.length;
      const added = prev.length === 0 || next[0] === prev[0] ? next.slice(-delta) : next.slice(0, delta);
      if (added.some(isHumanTurn)) {
        userMessagePendingRef.current = false;
      } else {
        userInputBaselineRef.current = next.length;
      }
    }
    rawSetMessages(next);
  }, []);
  // Capture the baseline message count alongside the placeholder text so
  // the render can hide it once displayedMessages grows past the baseline.
  const setUserInputOnProcessing = useCallback((input: string | undefined) => {
    if (input !== undefined) {
      userInputBaselineRef.current = messagesRef.current.length;
      userMessagePendingRef.current = true;
    } else {
      userMessagePendingRef.current = false;
    }
    setUserInputOnProcessingRaw(input);
  }, []);
  const syncToolResultReplacements = useCallback((replacements: ReadonlyMap<string, string>) => {
    if (replacements.size === 0) return;
    setMessages(current => applyToolResultReplacementsToMessages(current, replacements));
  }, [setMessages]);
  // Fullscreen: track the unseen-divider position. dividerIndex changes
  // only ~twice/scroll-session (first scroll-away + repin). pillVisible
  // and stickyPrompt now live in FullscreenLayout — they subscribe to
  // ScrollBox directly so per-frame scroll never re-renders REPL.
  const {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider
  } = useUnseenDivider(messages.length);
  if (feature('AWAY_SUMMARY')) {
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useAwaySummary(messages, setMessages, isLoading);
  }
  const [cursor, setCursor] = useState<MessageActionsState | null>(null);
  const cursorNavRef = useRef<MessageActionsNav | null>(null);
  // Memoized so Messages' React.memo holds.
  const unseenDivider = useMemo(() => computeUnseenDivider(messages, dividerIndex),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- length change covers appends; useUnseenDivider's count-drop guard clears dividerIndex on replace/rewind
    [dividerIndex, messages.length]);
  // Re-pin scroll to bottom and clear the unseen-messages baseline. Called
  // on any user-driven return-to-live action (submit, type-into-empty,
  // overlay appear/dismiss).
  const repinScroll = useCallback(() => {
    scrollRef.current?.scrollToBottom();
    onRepin();
    setCursor(null);
  }, [onRepin, setCursor]);
  // Backstop for the submit-handler repin at onSubmit. If a buffered stdin
  // event (wheel/drag) races between handler-fire and state-commit, the
  // handler's scrollToBottom can be undone. This effect fires on the render
  // where the user's message actually lands — tied to React's commit cycle,
  // so it can't race with stdin. Keyed on lastMsg identity (not messages.length)
  // so useAssistantHistory's prepends don't spuriously repin.
  const lastMsg = messages.at(-1);
  const lastMsgIsHuman = lastMsg != null && isHumanTurn(lastMsg);
  useEffect(() => {
    if (lastMsgIsHuman) {
      repinScroll();
    }
  }, [lastMsgIsHuman, lastMsg, repinScroll]);
  // Assistant-chat: lazy-load remote history on scroll-up. No-op unless
  // KAIROS build + config.viewerOnly. feature() is build-time constant so
  // the branch is dead-code-eliminated in non-KAIROS builds (same pattern
  // as useUnseenDivider above).
  const {
    maybeLoadOlder
  } = feature('KAIROS') ?
      // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useAssistantHistory({
        config: remoteSessionConfig,
        setMessages,
        scrollRef,
        onPrepend: shiftDivider
      }) : HISTORY_STUB;
  // Compose useUnseenDivider's callbacks with the lazy-load trigger.
  const composedOnScroll = useCallback((sticky: boolean, handle: ScrollBoxHandle) => {
    lastUserScrollTsRef.current = Date.now();
    if (sticky) {
      onRepin();
    } else {
      onScrollAway(handle);
      if (feature('KAIROS')) maybeLoadOlder(handle);
      // Dismiss the companion bubble on scroll — it's absolute-positioned
      // at bottom-right and covers transcript content. Scrolling = user is
      // trying to read something under it.
      if (isBuddyEnabled()) {
        setAppState(prev => prev.companionReaction === undefined ? prev : {
          ...prev,
          companionReaction: undefined
        });
      }
    }
  }, [onRepin, onScrollAway, maybeLoadOlder, setAppState]);
  // Deferred SessionStart hook messages — REPL renders immediately and
  // hook messages are injected when they resolve. awaitPendingHooks()
  // must be called before the first API call so the model sees hook context.
  const awaitPendingHooks = useDeferredHookMessages(pendingHookMessages, setMessages);

  // Deferred messages for the Messages component — renders at transition
  // priority so the reconciler yields every 5ms, keeping input responsive
  // while the expensive message processing pipeline runs.
  const deferredMessages = useDeferredValue(messages);
  const deferredBehind = messages.length - deferredMessages.length;
  if (deferredBehind > 0) {
    logForDebugging(`[useDeferredValue] Messages deferred by ${deferredBehind} (${deferredMessages.length}→${messages.length})`);
  }

  // Frozen state for transcript mode - stores lengths instead of cloning arrays for memory efficiency
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<{
    messagesLength: number;
    streamingToolUsesLength: number;
  } | null>(null);
  // Initialize input with any early input that was captured before REPL was ready.
  // Using lazy initialization ensures cursor offset is set correctly in PromptInput.
  const [inputValue, setInputValueRaw] = useState(() => consumeEarlyInput());
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const promptTypingSuppressionActive = isPromptTypingSuppressionActive(isPromptInputActive, inputValue);
  const insertTextRef = useRef<{
    insert: (text: string) => void;
    setInputWithCursor: (value: string, cursor: number) => void;
    cursorOffset: number;
  } | null>(null);

  // Wrap setInputValue to co-locate suppression state updates.
  // Both setState calls happen in the same synchronous context so React
  // batches them into a single render, eliminating the extra render that
  // the previous useEffect → setState pattern caused.
  const setInputValue = useCallback((value: string) => {
    if (trySuggestBgPRIntercept(inputValueRef.current, value)) return;
    // In fullscreen mode, typing into an empty prompt re-pins scroll to
    // bottom. Only fires on empty→non-empty so scrolling up to reference
    // something while composing a message doesn't yank the view back on
    // every keystroke. Restores the pre-fullscreen muscle memory of
    // typing to snap back to the end of the conversation.
    // Skipped if the user scrolled within the last 3s — they're actively
    // reading, not lost. lastUserScrollTsRef starts at 0 so the first-
    // ever keypress (no scroll yet) always repins.
    if (inputValueRef.current === '' && value !== '' && Date.now() - lastUserScrollTsRef.current >= RECENT_SCROLL_REPIN_WINDOW_MS) {
      repinScroll();
    }
    // Sync ref immediately (like setMessages) so callers that read
    // inputValueRef before React commits — e.g. the auto-restore finally
    // block's `=== ''` guard — see the fresh value, not the stale render.
    inputValueRef.current = value;
    setInputValueRaw(value);
    setIsPromptInputActive(value.trim().length > 0);
  }, [setIsPromptInputActive, repinScroll, trySuggestBgPRIntercept]);

  // Schedule a timeout to stop suppressing dialogs after the user stops typing.
  // Only manages the timeout — the immediate activation is handled by setInputValue above.
  useEffect(() => {
    if (inputValue.trim().length === 0) return;
    const timer = setTimeout(setIsPromptInputActive, PROMPT_SUPPRESSION_MS, false);
    return () => clearTimeout(timer);
  }, [inputValue]);
  const [inputMode, setInputMode] = useState<PromptInputMode>('prompt');
  const [stashedPrompt, setStashedPrompt] = useState<{
    text: string;
    cursorOffset: number;
    pastedContents: Record<number, PastedContent>;
  } | undefined>();

  // Callback to filter commands based on CCR's available slash commands
  const handleRemoteInit = useCallback((remoteSlashCommands: string[]) => {
    const remoteCommandSet = new Set(remoteSlashCommands);
    // Keep commands that CCR lists OR that are in the local-safe set
    setLocalCommands(prev => prev.filter(cmd => remoteCommandSet.has(cmd.name) || REMOTE_SAFE_COMMANDS.has(cmd)));
  }, [setLocalCommands]);
  const [inProgressToolUseIDs, setInProgressToolUseIDs] = useState<Set<string>>(new Set());
  const hasInterruptibleToolInProgressRef = useRef(false);

  // Remote session hook - manages WebSocket connection and message handling for --remote mode
  const remoteSession = useRemoteSession({
    config: remoteSessionConfig,
    setMessages,
    setIsLoading: setIsExternalLoading,
    onInit: handleRemoteInit,
    setToolUseConfirmQueue,
    tools: combinedInitialTools,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs
  });

  // Direct connect hook - manages WebSocket to a claude server for `claude connect` mode
  const directConnect = useDirectConnect({
    config: directConnectConfig,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools
  });

  // SSH session hook - manages ssh child process for `claude ssh` mode.
  // Same callback shape as useDirectConnect; only the transport under the
  // hood differs (ChildProcess stdin/stdout vs WebSocket).
  const sshRemote = useSSHSession({
    session: sshSession,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools
  });

  // Use whichever remote mode is active
  const activeRemote = sshRemote.isRemoteMode ? sshRemote : directConnect.isRemoteMode ? directConnect : remoteSession;
  const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({});
  const [submitCount, setSubmitCount] = useState(0);

  // Defer startup checks until the user has submitted their first message.
  // A timeout or grace period is insufficient (issue #363): if the user pauses
  // before typing, startup checks can still fire and recommendation dialogs
  // steal focus. Only the user's first submission guarantees the prompt was
  // the first thing they interacted with.
  const startupChecksStartedRef = React.useRef(false);
  const hasHadFirstSubmission = (submitCount ?? 0) > 0;
  useEffect(() => {
    if (isRemoteSession) return;
    if (startupChecksStartedRef.current) return;
    if (!shouldRunStartupChecks({
      isRemoteSession,
      hasStarted: startupChecksStartedRef.current,
      hasHadFirstSubmission,
    })) return;
    startupChecksStartedRef.current = true;
    void performStartupChecks(setAppState);
  }, [setAppState, isRemoteSession, hasHadFirstSubmission]);
  // Ref instead of state to avoid triggering React re-renders on every
  // streaming text_delta. The spinner reads this via its animation timer.
  const responseLengthRef = useRef(0);
  // API performance metrics ref for internal-only spinner display (TTFT/OTPS).
  // Accumulates metrics from all API requests in a turn for P50 aggregation.
  const apiMetricsRef = useRef<Array<{
    ttftMs: number;
    firstTokenTime: number;
    lastTokenTime: number;
    responseLengthBaseline: number;
    // Tracks responseLengthRef at the time of the last content addition.
    // Updated by both streaming deltas and subagent message content.
    // lastTokenTime is also updated at the same time, so the OTPS
    // denominator correctly includes subagent processing time.
    endResponseLength: number;
  }>>([]);
  const setResponseLength = useCallback((f: (prev: number) => number) => {
    const prev = responseLengthRef.current;
    responseLengthRef.current = f(prev);
    // When content is added (not a compaction reset), update the latest
    // metrics entry so OTPS reflects all content generation activity.
    // Updating lastTokenTime here ensures the denominator includes both
    // streaming time AND subagent execution time, preventing inflation.
    if (responseLengthRef.current > prev) {
      const entries = apiMetricsRef.current;
      if (entries.length > 0) {
        const lastEntry = entries.at(-1)!;
        lastEntry.lastTokenTime = Date.now();
        lastEntry.endResponseLength = responseLengthRef.current;
      }
    }
  }, []);

  // Streaming text display: routed through streamingTextStore instead of REPL
  // state. Appends are applied synchronously to the store value but listener
  // notification is coalesced to the frame interval, and the text itself is
  // only consumed by the StreamingTextRow leaf inside Messages — so per-delta
  // reconciliation shrinks from the whole REPL tree to one row. REPL
  // subscribes to presence only (null ↔ non-null, notified synchronously).
  // Cleared on message arrival (messages/streaming.ts) just before
  // onMessage's setMessages. Both updates land in the SAME task, so React
  // auto-batches them into one commit (Ink passes the LegacyRoot tag, but
  // react-reconciler 0.33 / React 19 compiled legacy mode out — the root
  // runs in ConcurrentMode and flushes async, after the task) — the
  // streaming-text → final-message switch is atomic. See
  // useStreamingTextStore.ts for the full invariant.
  const reducedMotion = useAppState(s => s.settings.prefersReducedMotion) ?? false;
  const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug();
  const onStreamingText = useCallback((f: (current: string | null) => string | null) => {
    if (!showStreamingText) return;
    streamingTextStore.update(f);
  }, [showStreamingText]);
  const hasStreamingText = useStreamingTextPresence();

  // Show streaming text as-is; the store's frame-interval coalescing and the
  // deferred-highlight system handle partial lines safely. The old "clip to
  // last \n" heuristic caused 2-3 s visual freezes whenever the model streamed
  // a long paragraph with no newline (substring(0,0) → '' → null → nothing shown).
  const hasVisibleStreamingText = hasStreamingText && showStreamingText;
  const [lastQueryCompletionTime, setLastQueryCompletionTime] = useState(0);
  const [spinnerMessage, setSpinnerMessage] = useState<string | null>(null);
  const [spinnerColor, setSpinnerColor] = useState<keyof Theme | null>(null);
  const [spinnerShimmerColor, setSpinnerShimmerColor] = useState<keyof Theme | null>(null);
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] = useState(false);
  const [messageSelectorPreselect, setMessageSelectorPreselect] = useState<UserMessage | undefined>(undefined);
  const [showCostDialog, setShowCostDialog] = useState(false);
  const [conversationId, setConversationId] = useState(randomUUID());

  // Idle-return dialog: shown when user submits after a long idle gap
  const [idleReturnPending, setIdleReturnPending] = useState<{
    input: string;
    idleMinutes: number;
  } | null>(null);
  const skipIdleCheckRef = useRef(false);
  const lastQueryCompletionTimeRef = useRef(lastQueryCompletionTime);
  lastQueryCompletionTimeRef.current = lastQueryCompletionTime;

  // Aggregate tool result budget: per-conversation decision tracking.
  // When the GrowthBook flag is on, query.ts enforces the budget; when
  // off (undefined), enforcement is skipped entirely. Stale entries after
  // /clear, rewind, or compact are harmless (tool_use_ids are UUIDs, stale
  // keys are never looked up). Memory is bounded by total replacement count
  // × ~2KB preview over the REPL lifetime — negligible.
  //
  // Lazy init via useState initializer — useRef(expr) evaluates expr on every
  // render (React ignores it after first, but the computation still runs).
  // For large resumed sessions, reconstruction does O(messages × blocks)
  // work; we only want that once.
  const [contentReplacementStateRef] = useState(() => ({
    current: provisionContentReplacementState(initialMessages, initialContentReplacements)
  }));
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(getGlobalConfig().hasAcknowledgedCostThreshold);
  const [vimMode, setVimMode] = useState<VimMode>('INSERT');
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const [showWorkflowsDialog, setShowWorkflowsDialog] = useState<string | boolean>(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // showBashesDialog is REPL-level so it survives PromptInput unmounting.
  // When ultraplan approval fires while the pill dialog is open, PromptInput
  // unmounts (focusedInputDialog → 'ultraplan-choice') but this stays true;
  // after accepting, PromptInput remounts into an empty "No tasks" dialog
  // (the completed ultraplan task has been filtered out). Close it here.
  useEffect(() => {
    if (ultraplanPendingChoice && showBashesDialog) {
      setShowBashesDialog(false);
    }
  }, [ultraplanPendingChoice, showBashesDialog]);
  const isTerminalFocused = useTerminalFocus();
  const terminalFocusRef = useRef(isTerminalFocused);
  terminalFocusRef.current = isTerminalFocused;
  const [theme] = useTheme();

  // resetLoadingState runs twice per turn (onQueryImpl tail + onQuery finally).
  // Without this guard, both calls pick a tip → two recordShownTip → two
  // saveGlobalConfig writes back-to-back. Reset at submit in onSubmit.
  const tipPickedThisTurnRef = React.useRef(false);
  const pickNewSpinnerTip = useCallback(() => {
    if (tipPickedThisTurnRef.current) return;
    tipPickedThisTurnRef.current = true;
    const newMessages = messagesRef.current.slice(bashToolsProcessedIdx.current);
    for (const tool of extractBashToolsFromMessages(newMessages)) {
      bashTools.current.add(tool);
    }
    bashToolsProcessedIdx.current = messagesRef.current.length;
    void getTipToShowOnSpinner({
      theme,
      readFileState: readFileState.current,
      bashTools: bashTools.current
    }).then(async tip => {
      if (tip) {
        const content = await tip.content({
          theme
        });
        setAppState(prev => ({
          ...prev,
          spinnerTip: content
        }));
        recordShownTip(tip);
      } else {
        setAppState(prev => {
          if (prev.spinnerTip === undefined) return prev;
          return {
            ...prev,
            spinnerTip: undefined
          };
        });
      }
    });
  }, [setAppState, theme]);

  // Resets UI loading state. Does NOT call onTurnComplete - that should be
  // called explicitly only when a query turn actually completes.
  const resetLoadingState = useCallback(() => {
    // isLoading is now derived from queryGuard — no setter call needed.
    // queryGuard.end() (onQuery finally) or cancelReservation() (executeUserInput
    // finally) have already transitioned the guard to idle by the time this runs.
    // External loading (remote/backgrounding) is reset separately by those hooks.
    setIsExternalLoading(false);
    setUserInputOnProcessing(undefined);
    responseLengthRef.current = 0;
    apiMetricsRef.current = [];
    streamingTextStore.clear();
    coalescedStreamingToolUses.cancel();
    setStreamingToolUses([]);
    setSpinnerMessage(null);
    setSpinnerColor(null);
    setSpinnerShimmerColor(null);
    pickNewSpinnerTip();
    endInteractionSpan();
    // Speculative bash classifier checks are only valid for the current
    // turn's commands — clear after each turn to avoid accumulating
    // Promise chains for unconsumed checks (denied/aborted paths).
    clearSpeculativeChecks();
  }, [pickNewSpinnerTip]);

  // Session backgrounding — hook is below, after getToolUseContext

  const hasRunningTeammates = useMemo(() => getAllInProcessTeammateTasks(tasks).some(t => t.status === 'running'), [tasks]);

  // Show deferred turn duration message once all swarm teammates finish
  useEffect(() => {
    if (!hasRunningTeammates && swarmStartTimeRef.current !== null) {
      const totalMs = Date.now() - swarmStartTimeRef.current;
      const deferredBudget = swarmBudgetInfoRef.current;
      swarmStartTimeRef.current = null;
      swarmBudgetInfoRef.current = undefined;
      setMessages(prev => [...prev, createTurnDurationMessage(totalMs, deferredBudget,
        // Count only what recordTranscript will persist — ephemeral
        // progress ticks and non-ant attachments are filtered by
        // isLoggableMessage and never reach disk. Using raw prev.length
        // would make checkResumeConsistency report false delta<0 for
        // every turn that ran a progress-emitting tool.
        count(prev, isLoggableMessage))]);
    }
  }, [hasRunningTeammates, setMessages]);

  // Show auto permissions warning when entering auto mode
  // (either via Shift+Tab toggle or on startup). Debounced to avoid
  // flashing when the user is cycling through modes quickly.
  // Only shown 3 times total across sessions.
  const safeYoloMessageShownRef = useRef(false);
  useEffect(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (toolPermissionContext.mode !== 'auto') {
        safeYoloMessageShownRef.current = false;
        return;
      }
      if (safeYoloMessageShownRef.current) return;
      const config = getGlobalConfig();
      const count = config.autoPermissionsNotificationCount ?? 0;
      if (count >= 3) return;
      const timer = setTimeout((ref, setMessages) => {
        ref.current = true;
        saveGlobalConfig(prev => {
          const prevCount = prev.autoPermissionsNotificationCount ?? 0;
          if (prevCount >= 3) return prev;
          return {
            ...prev,
            autoPermissionsNotificationCount: prevCount + 1
          };
        });
        setMessages(prev => [...prev, createSystemMessage(AUTO_MODE_DESCRIPTION, 'warning')]);
      }, 800, safeYoloMessageShownRef, setMessages);
      return () => clearTimeout(timer);
    }
  }, [toolPermissionContext.mode, setMessages]);

  // If worktree creation was slow and sparse-checkout isn't configured,
  // nudge the user toward settings.worktree.sparsePaths.
  const worktreeTipShownRef = useRef(false);
  useEffect(() => {
    if (worktreeTipShownRef.current) return;
    const wt = getCurrentWorktreeSession();
    if (!wt?.creationDurationMs || wt.usedSparsePaths) return;
    if (wt.creationDurationMs < 15_000) return;
    worktreeTipShownRef.current = true;
    const secs = Math.round(wt.creationDurationMs / 1000);
    setMessages(prev => [...prev, createSystemMessage(`Worktree creation took ${secs}s. For large repos, set \`worktree.sparsePaths\` in .claudin/settings.json to check out only the directories you need — e.g. \`{"worktree": {"sparsePaths": ["src", "packages/foo"]}}\`.`, 'info')]);
  }, [setMessages]);

  // Hide spinner when the only in-progress tool is Sleep
  const onlySleepToolActive = useMemo(() => {
    const lastAssistant = messages.findLast(m => m.type === 'assistant');
    if (lastAssistant?.type !== 'assistant') return false;
    const inProgressToolUses = lastAssistant.message.content.filter(b => b.type === 'tool_use' && inProgressToolUseIDs.has(b.id));
    return inProgressToolUses.length > 0 && inProgressToolUses.every(b => b.type === 'tool_use' && b.name === SLEEP_TOOL_NAME);
  }, [messages, inProgressToolUseIDs]);
  const {
    onBeforeQuery: mrOnBeforeQuery,
    onTurnComplete: mrOnTurnComplete,
    render: mrRender
  } = useMoreRight({
    enabled: moreRightEnabled,
    setMessages,
    inputValue,
    setInputValue,
    setToolJSX
  });
  const showSpinner = (!toolJSX || toolJSX.showSpinner === true) && toolUseConfirmQueue.length === 0 && promptQueue.length === 0 && (
    // Show spinner during input processing, API call, while teammates are running,
    // or while pending task notifications are queued (prevents spinner bounce between consecutive notifications)
    isLoading || !!userInputOnProcessing || hasRunningTeammates ||
    // Keep spinner visible while task notifications are queued for processing.
    // Without this, the spinner briefly disappears between consecutive notifications
    // (e.g., multiple background agents completing in rapid succession) because
    // isLoading goes false momentarily between processing each one.
    getCommandQueueLength() > 0) &&
    // Hide spinner when waiting for leader to approve permission request
    !pendingWorkerRequest && !onlySleepToolActive && (
      // Hide spinner when streaming text is visible (the text IS the feedback),
      // but keep it when isBriefOnly suppresses the streaming text display
      !hasVisibleStreamingText || isBriefOnly);

  // Check if any permission or ask question prompt is currently visible
  // This is used to prevent the survey from opening while prompts are active
  const hasActivePrompt = toolUseConfirmQueue.length > 0 || promptQueue.length > 0 || sandboxPermissionRequestQueue.length > 0 || elicitation.queue.length > 0 || workerSandboxPermissions.queue.length > 0;
  const feedbackSurveyOriginal = useFeedbackSurvey(messages, isLoading, submitCount, 'session', hasActivePrompt);
  const showIssueFlagBanner = useIssueFlagBanner(messages, submitCount);

  // Wrap feedback survey handler to trigger auto-run /issue
  const feedbackSurvey = useMemo(() => ({
    ...feedbackSurveyOriginal,
    handleSelect: (selected: 'dismissed' | 'bad' | 'fine' | 'good') => {
      // Reset the ref when a new survey response comes in
      didAutoRunIssueRef.current = false;
      const showedTranscriptPrompt = feedbackSurveyOriginal.handleSelect(selected);
      // Auto-run /issue for "bad" if transcript prompt wasn't shown
      if (selected === 'bad' && !showedTranscriptPrompt && shouldAutoRunIssue('feedback_survey_bad')) {
        setAutoRunIssueReason('feedback_survey_bad');
        didAutoRunIssueRef.current = true;
      }
    }
  }), [feedbackSurveyOriginal]);

  // Post-compact survey: shown after compaction if feature gate is enabled
  const postCompactSurvey = usePostCompactSurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession
  });

  // Memory survey: shown when the assistant mentions memory and a memory file
  // was read this conversation
  const memorySurvey = useMemorySurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession
  });

  // Frustration detection: show transcript sharing prompt after detecting frustrated messages
  const frustrationDetection = useFrustrationDetection(messages, isLoading, hasActivePrompt, feedbackSurvey.state !== 'closed' || postCompactSurvey.state !== 'closed' || memorySurvey.state !== 'closed');

  // Initialize IDE integration
  useIDEIntegration({
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState: setIDEInstallationStatus
  });
  useFileHistorySnapshotInit(initialFileHistorySnapshots, fileHistory, fileHistoryState => setAppState(prev => ({
    ...prev,
    fileHistory: fileHistoryState
  })));
  const resume = useCallback(async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
    await resumeSession(sessionId, log, entrypoint, {
      setAppState,
      store,
      mainThreadAgentDefinition,
      initialMainThreadAgentDefinition,
      agentDefinitions,
      setMainThreadAgentDefinition,
      mainLoopModel,
      restoreReadFileState,
      resetLoadingState,
      setAbortController,
      setConversationId,
      haikuTitleAttemptedRef,
      setHaikuTitle,
      contentReplacementStateRef,
      setMessages,
      setToolJSX,
      setInputValue,
    });
  }, [resetLoadingState, setAppState]);


  // Lazy init: useRef(createX()) would call createX on every render and
  // discard the result. LRUCache construction inside FileStateCache is
  // expensive (~170ms), so we use useState's lazy initializer to create
  // it exactly once, then feed that stable reference into useRef.
  const [initialReadFileState] = useState(() => createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE));
  const readFileState = useRef(initialReadFileState);
  const bashTools = useRef(new Set<string>());
  const bashToolsProcessedIdx = useRef(0);
  // Session-scoped skill discovery tracking (feeds was_discovered on
  // tengu_skill_tool_invocation). Must persist across getToolUseContext
  // rebuilds within a session: turn-0 discovery writes via processUserInput
  // before onQuery builds its own context, and discovery on turn N must
  // still attribute a SkillTool call on turn N+k. Cleared in clearConversation.
  const discoveredSkillNamesRef = useRef(new Set<string>());
  // Session-level dedup for nested_memory CLAUDE.md attachments.
  // readFileState is a 100-entry LRU; once it evicts a CLAUDE.md path,
  // the next discovery cycle re-injects it. Cleared in clearConversation.
  const loadedNestedMemoryPathsRef = useRef(new Set<string>());

  // Helper to restore read file state from messages (used for resume flows)
  // This allows Claude to edit files that were read in previous sessions
  const restoreReadFileState = useCallback((messages: MessageType[], cwd: string) => {
    const extracted = extractReadFilesFromMessages(messages, cwd, READ_FILE_STATE_CACHE_SIZE);
    // mergeReplacingLiveCache, NOT mergeFileStateCaches: the result is assigned
    // OVER readFileState.current, so it has to inherit the pin ownership of the
    // cache it replaces — otherwise the discarded owner takes its ownership set
    // with it and no pin in the session can be released early again.
    readFileState.current = mergeReplacingLiveCache(readFileState.current, extracted);
    for (const tool of extractBashToolsFromMessages(messages)) {
      bashTools.current.add(tool);
    }
  }, []);

  // Extract read file state from initialMessages on mount
  // This handles CLI flag resume (--resume-session) and ResumeConversation screen
  // where messages are passed as props rather than through the resume callback
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      restoreReadFileState(initialMessages, getOriginalCwd());
      void restoreRemoteAgentTasks({
        abortController: new AbortController(),
        getAppState: () => store.getState(),
        setAppState
      });
    }
    // Only run on mount - initialMessages shouldn't change during component lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const {
    status: apiKeyStatus,
    reverify
  } = useApiKeyVerification();

  // Auto-run /issue state
  const [autoRunIssueReason, setAutoRunIssueReason] = useState<AutoRunIssueReason | null>(null);
  // Ref to track if autoRunIssue was triggered this survey cycle,
  // so we can suppress the [1] follow-up prompt even after
  // autoRunIssueReason is cleared.
  const didAutoRunIssueRef = useRef(false);

  // Exit state machine + exit-flow node. See useReplExit for the state diagram
  // and the failsafe-timer rationale. The hook owns the refs and exposes only
  // the values REPL.tsx needs to render and arbitrate focus.
  const { exitFlow, isExiting, handleExit } = useReplExit();

  // Calculate if cost dialog should be shown
  const showingCostDialog = !isLoading && showCostDialog;

  // Determine which dialog should have focus (if any). Pure arbitration
  // extracted to src/agent/repl/utils/getFocusedInputDialog.ts so the
  // priority order is documented in one place and independently testable.
  // Permission and interactive dialogs can show even when toolJSX is set,
  // as long as shouldContinueAnimation is true. This prevents deadlocks when
  // agents set background hints while waiting for user interaction.
  const focusedInputDialog = getFocusedInputDialog({
    isExiting,
    exitFlow,
    isMessageSelectorVisible,
    promptTypingSuppressionActive,
    sandboxPermissionRequestQueue,
    toolJSX,
    toolUseConfirmQueue,
    promptQueue,
    workerSandboxPermissions,
    elicitation,
    showingCostDialog,
    idleReturnPending,
    ultraplanPendingChoice,
    ultraplanLaunchPending,
    isLoading,
    showIdeOnboarding,
    showEffortCallout,
    showRemoteCallout,
    hintRecommendation,
    showDesktopUpsellStartup,
    startupChecksStarted: startupChecksStartedRef.current,
  });

  // True when permission prompts exist but are hidden because the user is typing
  const hasSuppressedDialogs = promptTypingSuppressionActive && (sandboxPermissionRequestQueue[0] || toolUseConfirmQueue[0] || promptQueue[0] || workerSandboxPermissions.queue[0] || elicitation.queue[0] || showingCostDialog);

  // Keep ref in sync so timer callbacks can read the current value
  focusedInputDialogRef.current = focusedInputDialog;

  // Immediately capture pause/resume when focusedInputDialog changes
  // This ensures accurate timing even under high system load, rather than
  // relying on the 100ms polling interval to detect state changes
  useEffect(() => {
    if (!isLoading) return;
    const isPaused = focusedInputDialog === 'tool-permission';
    const now = Date.now();
    if (isPaused && pauseStartTimeRef.current === null) {
      // Just entered pause state - record the exact moment
      pauseStartTimeRef.current = now;
    } else if (!isPaused && pauseStartTimeRef.current !== null) {
      // Just exited pause state - accumulate paused time immediately
      totalPausedMsRef.current += now - pauseStartTimeRef.current;
      pauseStartTimeRef.current = null;
    }
  }, [focusedInputDialog, isLoading]);

  // Re-pin scroll to bottom whenever the permission overlay appears or
  // dismisses. Overlay now renders below messages inside the same
  // ScrollBox (no remount), so we need an explicit scrollToBottom for:
  //  - appear: user may have been scrolled up (sticky broken) — the
  //    dialog is blocking and must be visible
  //  - dismiss: user may have scrolled up to read context during the
  //    overlay, and onScroll was suppressed so the pill state is stale
  // useLayoutEffect so the re-pin commits before the Ink frame renders —
  // no 1-frame flash of the wrong scroll position.
  const prevDialogRef = useRef(focusedInputDialog);
  useLayoutEffect(() => {
    const was = prevDialogRef.current === 'tool-permission';
    const now = focusedInputDialog === 'tool-permission';
    if (was !== now) repinScroll();
    prevDialogRef.current = focusedInputDialog;
  }, [focusedInputDialog, repinScroll]);

  // When the permission dialog mounts/unmounts (or suppression flips it on/off
  // mid-typing), the bottom region's row count changes. Ink's blit fast path
  // can copy stale dialog cells into rows the new layout no longer covers,
  // leaving typed characters visually mixed with the dialog box until Ctrl+L.
  // invalidatePrevFrame() forces the next frame to do a full-damage diff.
  const prevDialogPresenceRef = useRef<boolean>(!!focusedInputDialog || !!hasSuppressedDialogs);
  useLayoutEffect(() => {
    const next = !!focusedInputDialog || !!hasSuppressedDialogs;
    if (next !== prevDialogPresenceRef.current) {
      instances.get(process.stdout)?.invalidatePrevFrame();
      prevDialogPresenceRef.current = next;
    }
  }, [focusedInputDialog, hasSuppressedDialogs]);
  function onCancel() {
    if (focusedInputDialog === 'elicitation') {
      // Elicitation dialog handles its own Escape, and closing it shouldn't affect any loading state.
      return;
    }
    logForDebugging(`[onCancel] focusedInputDialog=${focusedInputDialog} streamMode=${streamMode}`);

    // Pause proactive mode so the user gets control back.
    // It will resume when they submit their next input (see onSubmit).
    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.pauseProactive();
    }
    queryGuard.forceEnd();
    // Cancel path: forceEnd() bumps the generation so the stale finally's
    // end() returns false and won't accumulate — fold the partial active time
    // in here instead (idempotent if the turn already ended).
    markTurnEnd();
    skipIdleCheckRef.current = false;

    // Preserve partially-streamed text so the user can read what was
    // generated before pressing Esc. Pushed before resetLoadingState clears
    // the store, and before query.ts yields the async interrupt marker,
    // giving final order [user, partial-assistant, [Request interrupted by user]].
    // store.read() is synchronous, so this captures every delta received up
    // to the keypress (the old state read lagged by up to one render frame).
    const partialStreamingText = streamingTextStore.read();
    if (partialStreamingText?.trim()) {
      setMessages(prev => [...prev, createAssistantMessage({
        content: partialStreamingText
      })]);
    }
    resetLoadingState();

    // Clear any active token budget so the backstop doesn't fire on
    // a stale budget if the query generator hasn't exited yet.
    if (feature('TOKEN_BUDGET')) {
      snapshotOutputTokensForTurn(null);
    }
    if (focusedInputDialog === 'tool-permission') {
      // Tool use confirm handles the abort signal itself
      toolUseConfirmQueue[0]?.onAbort();
      setToolUseConfirmQueue([]);
    } else if (focusedInputDialog === 'prompt') {
      // Reject all pending prompts and clear the queue
      for (const item of promptQueue) {
        item.reject(new Error('Prompt cancelled by user'));
      }
      setPromptQueue([]);
      abortController?.abort('user-cancel');
    } else if (activeRemote.isRemoteMode) {
      // Remote mode: send interrupt signal to CCR
      activeRemote.cancelRequest();
    } else {
      abortController?.abort('user-cancel');
    }

    // Clear the controller so subsequent Escape presses don't see a stale
    // aborted signal. Without this, canCancelRunningTask is false (signal
    // defined but .aborted === true), so isActive becomes false if no other
    // activating conditions hold — leaving the Escape keybinding inactive.
    setAbortController(null);

    // forceEnd() skips the finally path — fire directly (aborted=true).
    void mrOnTurnComplete(messagesRef.current, true);
  }

  // Function to handle queued command when canceling a permission request
  const handleQueuedCommandOnCancel = useCallback(() => {
    const result = popAllEditable(inputValue, 0);
    if (!result) return;
    setInputValue(result.text);
    setInputMode('prompt');

    // Restore images from queued commands to pastedContents
    if (result.images.length > 0) {
      setPastedContents(prev => {
        const newContents = {
          ...prev
        };
        for (const image of result.images) {
          newContents[image.id] = image;
        }
        return newContents;
      });
    }
  }, [setInputValue, setInputMode, inputValue, setPastedContents]);

  // CancelRequestHandler props - rendered inside KeybindingSetup
  const cancelRequestProps = {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled: () => setMessages(prev => [...prev, createAgentsKilledMessage()]),
    isMessageSelectorVisible: isMessageSelectorVisible || !!showBashesDialog,
    screen,
    abortSignal: abortController?.signal,
    popCommandFromQueue: handleQueuedCommandOnCancel,
    vimMode,
    isLocalJSXCommand: toolJSX?.isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode
  };
  useEffect(() => {
    const totalCost = getTotalCost();
    if (totalCost >= 5 /* $5 */ && !showCostDialog && !haveShownCostDialog) {
      logEvent('tengu_cost_threshold_reached', {});
      // Mark as shown even if the dialog won't render (no console billing
      // access). Otherwise this effect re-fires on every message change for
      // the rest of the session — 200k+ spurious events observed.
      setHaveShownCostDialog(true);
      if (hasConsoleBillingAccess()) {
        setShowCostDialog(true);
      }
    }
  }, [messages, showCostDialog, haveShownCostDialog]);
  const sandboxAskCallback = useSandboxAsk({
    setAppState,
    store,
    setSandboxPermissionRequestQueue,
    sandboxBridgeCleanupRef,
  });

  // #34044: if user explicitly set sandbox.enabled=true but deps are missing,
  // isSandboxingEnabled() returns false silently. Surface the reason once at
  // mount so users know their security config isn't being enforced. Full
  // reason goes to debug log; notification points to /sandbox for details.
  // addNotification is stable (useCallback) so the effect fires once.
  useEffect(() => {
    const reason = SandboxManager.getSandboxUnavailableReason();
    if (!reason) return;
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(`\nError: sandbox required but unavailable: ${reason}\n` + `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`);
      gracefulShutdownSync(1, 'other');
      return;
    }
    logForDebugging(`sandbox disabled: ${reason}`, {
      level: 'warn'
    });
    addNotification({
      key: 'sandbox-unavailable',
      jsx: <>
        <Text color="warning">sandbox disabled</Text>
        <Text dimColor> · /sandbox</Text>
      </>,
      priority: 'medium'
    });
  }, [addNotification]);
  if (SandboxManager.isSandboxingEnabled()) {
    // If sandboxing is enabled (setting.sandbox is defined, initialise the manager)
    SandboxManager.initialize(sandboxAskCallback).catch(err => {
      // Initialization/validation failed - display error and exit
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`);
      gracefulShutdownSync(1, 'other');
    });
  }
  const {
    setToolPermissionContext,
    canUseTool,
    getToolUseContext,
    handleBackgroundQuery
  } = useToolUseContext({
    commands,
    debug,
    disabled,
    combinedInitialTools,
    initialMcpClients,
    mainThreadAgentDefinition,
    allowedAgentTypes,
    customSystemPrompt,
    appendSystemPrompt,
    thinkingConfig,
    dynamicMcpConfig,
    ideInstallationStatus,
    theme,
    terminal,
    terminalTitle,
    mainLoopModel,
    toolPermissionContext,
    abortController,
    store,
    messagesRef,
    readFileState,
    discoveredSkillNamesRef,
    loadedNestedMemoryPathsRef,
    contentReplacementStateRef,
    hasInterruptibleToolInProgressRef,
    resume,
    reverify,
    onChangeDynamicMcpConfig,
    syncToolResultReplacements,
    addNotification,
    setToolJSX,
    setAppState,
    setMessages,
    setConversationId,
    setToolUseConfirmQueue,
    setPromptQueue,
    setIsMessageSelectorVisible,
    setIDEToInstallExtension,
    setInProgressToolUseIDs,
    setResponseLength,
    setStreamMode,
    setSpinnerColor,
    setSpinnerShimmerColor,
    setSpinnerMessage,
  });
  const {
    handleBackgroundSession
  } = useSessionBackgrounding({
    setMessages,
    setIsLoading: setIsExternalLoading,
    resetLoadingState,
    setAbortController,
    onBackgroundQuery: handleBackgroundQuery
  });
  const {
    onQuery
  } = useOnQuery({
    getToolUseContext,
    canUseTool,
    queryGuard,
    store,
    toolPermissionContext,
    initialMcpClients,
    mainThreadAgentDefinition,
    customSystemPrompt,
    appendSystemPrompt,
    onTurnComplete,
    sessionTitle,
    agentTitle,
    titleDisabled,
    setHaikuTitle,
    haikuTitleAttemptedRef,
    mrOnBeforeQuery,
    mrOnTurnComplete,
    coalescedStreamingToolUses,
    onStreamingText,
    setStreamingThinking,
    setStreamingToolUses,
    setStreamMode,
    setResponseLength,
    messagesRef,
    inputValueRef,
    restoreMessageSyncRef,
    sendBridgeResultRef,
    contentReplacementStateRef,
    responseLengthRef,
    apiMetricsRef,
    loadingStartTimeRef,
    totalPausedMsRef,
    swarmStartTimeRef,
    swarmBudgetInfoRef,
    terminalFocusRef,
    skipIdleCheckRef,
    proactiveActive,
    setMessages,
    setAppState,
    setAbortController,
    setConversationId,
    setLastQueryCompletionTime,
    resetLoadingState,
    resetTimingRefs,
  });

  // Handle initial message (from CLI args or plan mode exit with context clear)
  // This effect runs when isLoading becomes false and there's a pending message
  const initialMessageRef = useRef(false);
  useEffect(() => {
    const pending = initialMessage;
    if (!pending || isLoading || initialMessageRef.current) return;

    // Mark as processing to prevent re-entry
    initialMessageRef.current = true;
    async function processInitialMessage(initialMsg: NonNullable<typeof pending>) {
      // `initialMsg.message` is typed as plain UserMessage in AppStateStore,
      // but ExitPlanModePermissionRequest bolts on `planContent` when exiting
      // plan mode — same intersection Message.tsx uses for the same reason.
      const initialMsgMessage = initialMsg.message as UserMessage & { planContent?: string };
      // Clear context if requested (plan mode exit)
      if (initialMsg.clearContext) {
        // Preserve the plan slug before clearing context, so the new session
        // can access the same plan file after regenerateSessionId()
        const oldPlanSlug = initialMsgMessage.planContent ? getPlanSlug() : undefined;
        const {
          clearConversation
        } = await import('src/commands/clear/conversation.js');
        await clearConversation({
          setMessages,
          readFileState: readFileState.current,
          discoveredSkillNames: discoveredSkillNamesRef.current,
          loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
          getAppState: () => store.getState(),
          setAppState,
          setConversationId
        });
        haikuTitleAttemptedRef.current = false;
        setHaikuTitle(undefined);
        bashTools.current.clear();
        bashToolsProcessedIdx.current = 0;

        // Restore the plan slug for the new session so getPlan() finds the file
        if (oldPlanSlug) {
          setPlanSlug(getSessionId(), oldPlanSlug);
        }
      }

      // Atomically: clear initial message and set permission mode and rules
      setAppState(prev => {
        // Build and apply permission updates (mode + allowedPrompts rules)
        let updatedToolPermissionContext = initialMsg.mode ? applyPermissionUpdates(prev.toolPermissionContext, buildPermissionUpdates(initialMsg.mode, initialMsg.allowedPrompts)) : prev.toolPermissionContext;
        // For auto, override the mode (buildPermissionUpdates maps
        // it to 'default' via toExternalPermissionMode) and strip dangerous rules
        if (feature('TRANSCRIPT_CLASSIFIER') && initialMsg.mode === 'auto') {
          updatedToolPermissionContext = stripDangerousPermissionsForAutoMode({
            ...updatedToolPermissionContext,
            mode: 'auto',
            prePlanMode: undefined
          });
        }
        return {
          ...prev,
          initialMessage: null,
          toolPermissionContext: updatedToolPermissionContext
        };
      });

      // Create file history snapshot for code rewind
      if (fileHistoryEnabled()) {
        void fileHistoryMakeSnapshot((updater: (prev: FileHistoryState) => FileHistoryState) => {
          setAppState(prev => ({
            ...prev,
            fileHistory: updater(prev.fileHistory)
          }));
        }, initialMsg.message.uuid);
      }

      // Ensure SessionStart hook context is available before the first API
      // call. onSubmit calls this internally but the onQuery path below
      // bypasses onSubmit — hoist here so both paths see hook messages.
      await awaitPendingHooks();

      // Route all initial prompts through onSubmit to ensure UserPromptSubmit hooks fire
      // TODO: Simplify by always routing through onSubmit once it supports
      // ContentBlockParam arrays (images) as input
      const content = initialMsg.message.message.content;

      // Route all string content through onSubmit to ensure hooks fire
      // For complex content (images, etc.), fall back to direct onQuery
      // Plan messages bypass onSubmit to preserve planContent metadata for rendering
      if (typeof content === 'string' && !initialMsgMessage.planContent) {
        // Route through onSubmit for proper processing including UserPromptSubmit hooks
        void onSubmit(content, {
          setCursorOffset: () => { },
          clearBuffer: () => { },
          resetHistory: () => { }
        });
      } else {
        // Plan messages or complex content (images, etc.) - send directly to model
        // Plan messages use onQuery to preserve planContent metadata for rendering
        // TODO: Once onSubmit supports ContentBlockParam arrays, remove this branch
        const newAbortController = createAbortController();
        setAbortController(newAbortController);
        void onQuery([initialMsg.message], newAbortController, true,
          // shouldQuery
          [],
          // additionalAllowedTools
          mainLoopModel);
      }

      // Reset ref after a delay to allow new initial messages
      setTimeout(ref => {
        ref.current = false;
      }, 100, initialMessageRef);
    }
    void processInitialMessage(pending);
  }, [initialMessage, isLoading, setMessages, setAppState, onQuery, mainLoopModel, tools]);
  const onSubmit = useOnSubmit({
    onQuery,
    getToolUseContext,
    canUseTool,
    onBeforeQuery,
    queryGuard,
    awaitPendingHooks,
    commands,
    mainLoopModel,
    ideSelection,
    isLoading,
    isExternalLoading,
    abortController,
    activeRemote,
    remoteSession,
    inputMode,
    pastedContents,
    stashedPrompt,
    messagesRef,
    inputValueRef,
    readFileState,
    streamModeRef,
    idleHintShownRef,
    lastQueryCompletionTimeRef,
    skipIdleCheckRef,
    tipPickedThisTurnRef,
    hasInterruptibleToolInProgressRef,
    setMessages,
    setAppState,
    setAbortController,
    setInputValue,
    setInputMode,
    setPastedContents,
    setStashedPrompt,
    setSubmitCount,
    setIDESelection,
    setIdleReturnPending,
    setUserInputOnProcessing,
    setToolJSX,
    addNotification,
    repinScroll,
    resetTimingRefs,
  });

  // Callback for when user submits input while viewing a teammate's transcript
  const onAgentSubmit = useCallback(async (input: string, task: InProcessTeammateTaskState | LocalAgentTaskState, helpers: PromptInputHelpers) => {
    if (isLocalAgentTask(task)) {
      appendMessageToLocalAgent(task.id, createUserMessage({
        content: input
      }), setAppState);
      if (task.status === 'running') {
        queuePendingMessage(task.id, input, setAppState);
      } else {
        void resumeAgentBackground({
          agentId: task.id,
          prompt: input,
          toolUseContext: getToolUseContext(messagesRef.current, [], new AbortController(), mainLoopModel),
          canUseTool
        }).catch(err => {
          logForDebugging(`resumeAgentBackground failed: ${errorMessage(err)}`);
          addNotification({
            key: `resume-agent-failed-${task.id}`,
            jsx: <Text color="error">
              Failed to resume agent: {errorMessage(err)}
            </Text>,
            priority: 'low'
          });
        });
      }
    } else {
      injectUserMessageToTeammate(task.id, input, setAppState);
    }
    setInputValue('');
    helpers.setCursorOffset(0);
    helpers.clearBuffer();
  }, [setAppState, setInputValue, getToolUseContext, canUseTool, mainLoopModel, addNotification]);

  // Handlers for auto-run /issue or /good-claude (defined after onSubmit)
  const handleAutoRunIssue = useCallback(() => {
    const command = autoRunIssueReason ? getAutoRunCommand(autoRunIssueReason) : '/issue';
    setAutoRunIssueReason(null); // Clear the state
    onSubmit(command, {
      setCursorOffset: () => { },
      clearBuffer: () => { },
      resetHistory: () => { }
    }).catch(err => {
      logForDebugging(`Auto-run ${command} failed: ${errorMessage(err)}`);
    });
  }, [onSubmit, autoRunIssueReason]);
  const handleCancelAutoRunIssue = useCallback(() => {
    setAutoRunIssueReason(null);
  }, []);

  // Handler for when user presses 1 on survey thanks screen to share details
  const handleSurveyRequestFeedback = useCallback(() => {
    const command = '/feedback';
    onSubmit(command, {
      setCursorOffset: () => { },
      clearBuffer: () => { },
      resetHistory: () => { }
    }).catch(err => {
      logForDebugging(`Survey feedback request failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [onSubmit]);

  // onSubmit is unstable (deps include `messages` which changes every turn).
  // `handleOpenRateLimitOptions` is prop-drilled to every MessageRow, and each
  // MessageRow fiber pins the closure (and transitively the entire REPL render
  // scope, ~1.8KB) at mount time. Using a ref keeps this callback stable so
  // old REPL scopes can be GC'd — saves ~35MB over a 1000-turn session.
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const handleOpenRateLimitOptions = useCallback(() => {
    void onSubmitRef.current('/rate-limit-options', {
      setCursorOffset: () => { },
      clearBuffer: () => { },
      resetHistory: () => { }
    });
  }, []);
  // Exit state machine + failsafe live in useReplExit (called above, near the
  // other early `useState`s). The previous inline 60-line implementation was
  // moved verbatim — see src/agent/repl/hooks/useReplExit.tsx for the
  // state diagram and SIGKILL failsafe rationale.
  //
  // Sync the ref so the early useExitOnCtrlCDWithKeybindings hook (defined
  // above this declaration) can dispatch into handleExit even though the
  // callback identity only materializes here in render order.
  handleExitRef.current = handleExit;
  const handleShowMessageSelector = useCallback(() => {
    setIsMessageSelectorVisible(prev => !prev);
  }, []);

  // Rewind conversation state to just before `message`: slice messages,
  // reset conversation ID, microcompact state, permission mode, prompt suggestion.
  // Does NOT touch the prompt input. Index is computed from messagesRef (always
  // fresh via the setMessages wrapper) so callers don't need to worry about
  // stale closures.
  const {
    handleRestoreMessage,
    messageActionCaps
  } = useMessageActionsController({
    messages,
    messagesRef,
    restoreMessageSyncRef,
    fileHistory,
    setMessages,
    setAppState,
    setConversationId,
    setInputValue,
    setInputMode,
    setPastedContents,
    setMessageSelectorPreselect,
    setIsMessageSelectorVisible,
    addNotification,
    onCancel,
  });
  const {
    enter: enterMessageActions,
    handlers: messageActionHandlers
  } = useMessageActions(cursor, setCursor, cursorNavRef, messageActionCaps);
  async function onInit() {
    // Always verify API key on startup, so we can show the user an error in the
    // bottom right corner of the screen if the API key is invalid.
    void reverify();

    // Populate readFileState with CLAUDE.md files at startup
    const memoryFiles = await getMemoryFiles();
    if (memoryFiles.length > 0) {
      const fileList = memoryFiles.map(f => `  [${f.type}] ${f.path} (${f.content.length} chars)${f.parent ? ` (included by ${f.parent})` : ''}`).join('\n');
      logForDebugging(`Loaded ${memoryFiles.length} CLAUDE.md/rules files:\n${fileList}`);
    } else {
      logForDebugging('No CLAUDE.md/rules files found');
    }
    for (const file of memoryFiles) {
      // When the injected content doesn't match disk (stripped HTML comments,
      // stripped frontmatter, MEMORY.md truncation), cache the RAW disk bytes
      // with isPartialView so Edit/Write require a real Read first while
      // getChangedFiles + nested_memory dedup still work.
      readFileState.current.set(file.path, {
        content: file.contentDiffersFromDisk ? file.rawContent ?? file.content : file.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: file.contentDiffersFromDisk
      });
    }

    // Initial message handling is done via the initialMessage effect
  }

  // Register cost summary tracker
  useCostSummary(useFpsMetrics());

  // Record transcripts locally, for debugging and conversation recovery
  // Don't record conversation if we only have initial messages; optimizes
  // the case where user resumes a conversation then quites before doing
  // anything else
  useLogMessages(messages, messages.length === initialMessages?.length);

  // REPL Bridge: replicate user/assistant messages to the bridge session
  // for remote access via claude.ai. No-op in external builds or when not enabled.
  const {
    sendBridgeResult
  } = useReplBridge(messages, setMessages, abortControllerRef, commands, mainLoopModel);
  sendBridgeResultRef.current = sendBridgeResult;
  useAfterFirstRender();

  // Track prompt queue usage for analytics. Fire once per transition from
  // empty to non-empty, not on every length change -- otherwise a render loop
  // (concurrent onQuery thrashing, etc.) spams saveGlobalConfig, which hits
  // ELOCKED under concurrent sessions and falls back to unlocked writes.
  // That write storm is the primary trigger for ~/.claudin/config.json corruption
  // (GH #3117).
  const hasCountedQueueUseRef = useRef(false);
  useEffect(() => {
    if (queuedCommands.length < 1) {
      hasCountedQueueUseRef.current = false;
      return;
    }
    if (hasCountedQueueUseRef.current) return;
    hasCountedQueueUseRef.current = true;
    saveGlobalConfig(current => ({
      ...current,
      promptQueueUseCount: (current.promptQueueUseCount ?? 0) + 1
    }));
  }, [queuedCommands.length]);

  // Process queued commands when query completes and queue has items

  const executeQueuedInput = useCallback(async (queuedCommands: QueuedCommand[]) => {
    await handlePromptSubmit({
      helpers: {
        setCursorOffset: () => { },
        clearBuffer: () => { },
        resetHistory: () => { }
      },
      queryGuard,
      commands,
      onInputChange: () => { },
      setPastedContents: () => { },
      setToolJSX,
      getToolUseContext,
      messages,
      mainLoopModel,
      ideSelection,
      setUserInputOnProcessing,
      setAbortController,
      onQuery,
      setAppState,
      querySource: getQuerySourceForREPL(),
      onBeforeQuery,
      canUseTool,
      addNotification,
      setMessages,
      queuedCommands
    });
  }, [queryGuard, commands, setToolJSX, getToolUseContext, messages, mainLoopModel, ideSelection, setUserInputOnProcessing, canUseTool, setAbortController, onQuery, addNotification, setAppState, onBeforeQuery]);
  useQueueProcessor({
    executeQueuedInput,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    queryGuard
  });

  // We'll use the global lastInteractionTime from state.ts

  // Update last interaction time when input changes.
  // Must be immediate because useEffect runs after the Ink render cycle flush.
  useEffect(() => {
    activityManager.recordUserActivity();
    updateLastInteractionTime(true);
  }, [inputValue, submitCount]);
  useEffect(() => {
    if (submitCount === 1) {
      startBackgroundHousekeeping();
    }
  }, [submitCount]);

  // Show notification when Claude is done responding and user is idle
  useEffect(() => {
    // Don't set up notification if Claude is busy
    if (isLoading) return;

    // Only enable notifications after the first new interaction in this session
    if (submitCount === 0) return;

    // No query has completed yet
    if (lastQueryCompletionTime === 0) return;

    // Set timeout to check idle state
    const timer = setTimeout((lastQueryCompletionTime, isLoading, toolJSX, focusedInputDialogRef, terminal) => {
      // Check if user has interacted since the response ended
      const lastUserInteraction = getLastInteractionTime();
      if (lastUserInteraction > lastQueryCompletionTime) {
        // User has interacted since Claude finished - they're not idle, don't notify
        return;
      }

      // User hasn't interacted since response ended, check other conditions
      const idleTimeSinceResponse = Date.now() - lastQueryCompletionTime;
      if (!isLoading && !toolJSX &&
        // Use ref to get current dialog state, avoiding stale closure
        focusedInputDialogRef.current === undefined && idleTimeSinceResponse >= getGlobalConfig().messageIdleNotifThresholdMs) {
        void sendNotification({
          message: 'Claude is waiting for your input',
          notificationType: 'idle_prompt'
        }, terminal);
      }
    }, getGlobalConfig().messageIdleNotifThresholdMs, lastQueryCompletionTime, isLoading, toolJSX, focusedInputDialogRef, terminal);
    return () => clearTimeout(timer);
  }, [isLoading, toolJSX, submitCount, lastQueryCompletionTime, terminal]);

  // Idle-return hint: show notification when idle threshold is exceeded.
  // Timer fires after the configured idle period; notification persists until
  // dismissed or the user submits.
  useEffect(() => {
    if (lastQueryCompletionTime === 0) return;
    if (isLoading) return;
    const willowMode: string = getFeatureValue_CACHED_MAY_BE_STALE('tengu_willow_mode', 'off');
    if (willowMode !== 'hint' && willowMode !== 'hint_v2') return;
    if (getGlobalConfig().idleReturnDismissed) return;
    const tokenThreshold = Number(process.env.CLAUDIN_IDLE_TOKEN_THRESHOLD ?? 100_000);
    if (getTotalInputTokens() < tokenThreshold) return;
    const idleThresholdMs = Number(process.env.CLAUDIN_IDLE_THRESHOLD_MINUTES ?? 75) * 60_000;
    const elapsed = Date.now() - lastQueryCompletionTime;
    const remaining = idleThresholdMs - elapsed;
    const timer = setTimeout((lqct, addNotif, msgsRef, mode, hintRef) => {
      if (msgsRef.current.length === 0) return;
      const totalTokens = getTotalInputTokens();
      const formattedTokens = formatTokens(totalTokens);
      const idleMinutes = (Date.now() - lqct) / 60_000;
      addNotif({
        key: 'idle-return-hint',
        jsx: mode === 'hint_v2' ? <>
          <Text dimColor>new task? </Text>
          <Text color="suggestion">/clear</Text>
          <Text dimColor> to save </Text>
          <Text color="suggestion">{formattedTokens} tokens</Text>
        </> : <Text color="warning">
          new task? /clear to save {formattedTokens} tokens
        </Text>,
        priority: 'medium',
        // Persist until submit — the hint fires at T+75min idle, user may
        // not return for hours. removeNotification in useEffect cleanup
        // handles dismissal. 0x7FFFFFFF = setTimeout max (~24.8 days).
        timeoutMs: 0x7fffffff
      });
      hintRef.current = mode;
      logEvent('tengu_idle_return_action', {
        action: 'hint_shown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        variant: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        idleMinutes: Math.round(idleMinutes),
        messageCount: msgsRef.current.length,
        totalInputTokens: totalTokens
      });
    }, Math.max(0, remaining), lastQueryCompletionTime, addNotification, messagesRef, willowMode, idleHintShownRef);
    return () => {
      clearTimeout(timer);
      removeNotification('idle-return-hint');
      idleHintShownRef.current = false;
    };
  }, [lastQueryCompletionTime, isLoading, addNotification, removeNotification]);

  // Submits incoming prompts from teammate messages or tasks mode as new turns
  // Returns true if submission succeeded, false if a query is already running
  const handleIncomingPrompt = useCallback((content: string, options?: {
    isMeta?: boolean;
  }): boolean => {
    if (queryGuard.isActive) return false;

    // Defer to user-queued commands — user input always takes priority
    // over system messages (teammate messages, task list items, etc.)
    // Read from the module-level store at call time (not the render-time
    // snapshot) to avoid a stale closure — this callback's deps don't
    // include the queue.
    if (getCommandQueue().some(cmd => cmd.mode === 'prompt' || cmd.mode === 'bash')) {
      return false;
    }
    const newAbortController = createAbortController();
    setAbortController(newAbortController);

    // Create a user message with the formatted content (includes XML wrapper)
    const userMessage = createUserMessage({
      content,
      isMeta: options?.isMeta ? true : undefined
    });
    void onQuery([userMessage], newAbortController, true, [], mainLoopModel);
    return true;
  }, [onQuery, mainLoopModel, store]);

  // Voice input integration (VOICE_MODE builds only)
  const voice = feature('VOICE_MODE') ?
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useVoiceIntegration({
      setInputValueRaw,
      inputValueRef,
      insertTextRef
    }) : {
      stripTrailing: () => 0,
      handleKeyEvent: () => { },
      resetAnchor: () => { },
      interimRange: null
    };
  useInboxPoller({
    enabled: isAgentSwarmsEnabled(),
    isLoading,
    focusedInputDialog,
    onSubmitMessage: handleIncomingPrompt
  });
  useMailboxBridge({
    isLoading,
    onSubmitMessage: handleIncomingPrompt
  });

  // Scheduled tasks from .claudin/scheduled_tasks.json (CronCreate/Delete/List)
  // and session-only /loop runs.
  const assistantMode = store.getState().kairosEnabled;
  useScheduledTasks({
    isLoading,
    assistantMode,
    setMessages
  });

  // Note: Permission polling is now handled by useInboxPoller
  // - Workers receive permission responses via mailbox messages
  // - Leaders receive permission requests via mailbox messages

  // Abort the current operation when a 'now' priority message arrives
  // (e.g. from a chat UI client via UDS).
  useEffect(() => {
    if (queuedCommands.some(cmd => cmd.priority === 'now')) {
      abortControllerRef.current?.abort('interrupt');
    }
  }, [queuedCommands]);

  // Initial load
  useEffect(() => {
    void onInit();

    // Cleanup on unmount
    return () => {
      void diagnosticTracker.shutdown();
    };
    // TODO: fix this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for suspend/resume events
  const {
    internal_eventEmitter
  } = useStdin();
  const [remountKey, setRemountKey] = useState(0);
  useEffect(() => {
    const handleSuspend = () => {
      // Print suspension instructions
      process.stdout.write(`\nClaudin has been suspended. Run \`fg\` to bring Claudin back.\nNote: ctrl + z now suspends Claudin, ctrl + _ undoes input.\n`);
    };
    const handleResume = () => {
      // Force complete component tree replacement instead of terminal clear
      // Ink now handles line count reset internally on SIGCONT
      setRemountKey(prev => prev + 1);
    };
    internal_eventEmitter?.on('suspend', handleSuspend);
    internal_eventEmitter?.on('resume', handleResume);
    return () => {
      internal_eventEmitter?.off('suspend', handleSuspend);
      internal_eventEmitter?.off('resume', handleResume);
    };
  }, [internal_eventEmitter]);

  // Derive stop hook spinner suffix from messages state
  const stopHookSpinnerSuffix = useMemo(() => {
    if (!isLoading) return null;

    // Find stop hook progress messages
    const progressMsgs = messages.filter((m): m is ProgressMessage<HookProgress> => m.type === 'progress' && m.data.type === 'hook_progress' && (m.data.hookEvent === 'Stop' || m.data.hookEvent === 'SubagentStop'));
    if (progressMsgs.length === 0) return null;

    // Get the most recent stop hook execution
    const currentToolUseID = progressMsgs.at(-1)?.toolUseID;
    if (!currentToolUseID) return null;

    // Check if there's already a summary message for this execution (hooks completed)
    const hasSummaryForCurrentExecution = messages.some(m => m.type === 'system' && m.subtype === 'stop_hook_summary' && m.toolUseID === currentToolUseID);
    if (hasSummaryForCurrentExecution) return null;
    const currentHooks = progressMsgs.filter(p => p.toolUseID === currentToolUseID);
    const total = currentHooks.length;

    // Count completed hooks
    const completedCount = count(messages, m => {
      if (m.type !== 'attachment') return false;
      const attachment = m.attachment;
      return 'hookEvent' in attachment && (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') && 'toolUseID' in attachment && attachment.toolUseID === currentToolUseID;
    });

    // Check if any hook has a custom status message
    const customMessage = currentHooks.find(p => p.data.statusMessage)?.data.statusMessage;
    if (customMessage) {
      // Use custom message with progress counter if multiple hooks
      return total === 1 ? `${customMessage}…` : `${customMessage}… ${completedCount}/${total}`;
    }

    // Fall back to default behavior
    const hookType = currentHooks[0]?.data.hookEvent === 'SubagentStop' ? 'subagent stop' : 'stop';
    return total === 1 ? `running ${hookType} hook` : `running stop hooks… ${completedCount}/${total}`;
  }, [messages, isLoading]);

  // Callback to capture frozen state when entering transcript mode
  const handleEnterTranscript = useCallback(() => {
    setFrozenTranscriptState({
      messagesLength: messages.length,
      streamingToolUsesLength: streamingToolUses.length
    });
  }, [messages.length, streamingToolUses.length]);

  // Callback to clear frozen state when exiting transcript mode
  const handleExitTranscript = useCallback(() => {
    setFrozenTranscriptState(null);
  }, []);

  // Props for GlobalKeybindingHandlers component (rendered inside KeybindingSetup)
  const virtualScrollActive = isFullscreenEnvEnabled() && !disableVirtualScroll;

  // Transcript search state. Hooks must be unconditional so they live here
  // (not inside the `if (screen === 'transcript')` branch below); isActive
  // gates the useInput. Query persists across bar open/close so n/N keep
  // working after Enter dismisses the bar (less semantics).
  const jumpRef = useRef<JumpHandle | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCount, setSearchCount] = useState(0);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchCount(count);
    setSearchCurrent(current);
  }, []);
  useInput((input, key, event) => {
    if (key.ctrl || key.meta) return;
    // No Esc handling here — less has no navigating mode. Search state
    // (highlights, n/N) is just state. Esc/q/ctrl+c → transcript:exit
    // (ungated). Highlights clear on exit via the screen-change effect.
    if (input === '/') {
      // Capture scrollTop NOW — typing is a preview, 0-matches snaps
      // back here. Synchronous ref write, fires before the bar's
      // mount-effect calls setSearchQuery.
      jumpRef.current?.setAnchor();
      setSearchOpen(true);
      event.stopImmediatePropagation();
      return;
    }
    // Held-key batching: tokenizer coalesces to 'nnn'. Same uniform-batch
    // pattern as modalPagerAction in ScrollKeybindingHandler.tsx. Each
    // repeat is a step (n isn't idempotent like g).
    const c = input[0];
    if ((c === 'n' || c === 'N') && input === c.repeat(input.length) && searchCount > 0) {
      const fn = c === 'n' ? jumpRef.current?.nextMatch : jumpRef.current?.prevMatch;
      if (fn) for (let i = 0; i < input.length; i++) fn();
      event.stopImmediatePropagation();
    }
  },
    // Search needs virtual scroll (jumpRef drives VirtualMessageList). [
    // kills it, so !dumpMode — after [ there's nothing to jump in.
    {
      isActive: screen === 'transcript' && virtualScrollActive && !searchOpen && !dumpMode
    });
  const {
    setQuery: setHighlight,
    scanElement,
    setPositions
  } = useSearchHighlight();

  // Resize → abort search. Positions are (msg, query, WIDTH)-keyed —
  // cached positions are stale after a width change (new layout, new
  // wrapping). Clearing searchQuery triggers VML's setSearchQuery('')
  // which clears positionsCache + setPositions(null). Bar closes.
  // User hits / again → fresh everything.
  const transcriptCols = useTerminalSize().columns;
  const prevColsRef = React.useRef(transcriptCols);
  React.useEffect(() => {
    if (prevColsRef.current !== transcriptCols) {
      prevColsRef.current = transcriptCols;
      if (searchQuery || searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
        setSearchCount(0);
        setSearchCurrent(0);
        jumpRef.current?.disarmSearch();
        setHighlight('');
      }
    }
  }, [transcriptCols, searchQuery, searchOpen, setHighlight]);

  // Transcript escape hatches. Bare letters in modal context (no prompt
  // competing for input) — same class as g/G/j/k in ScrollKeybindingHandler.
  useInput((input, key, event) => {
    if (key.ctrl || key.meta) return;
    if (input === 'q') {
      // less: q quits the pager. ctrl+o toggles; q is the lineage exit.
      handleExitTranscript();
      event.stopImmediatePropagation();
      return;
    }
    if (input === '[' && !dumpMode) {
      // Force dump-to-scrollback. Also expand + uncap — no point dumping
      // a subset. Terminal/tmux cmd-F can now find anything. Guard here
      // (not in isActive) so v still works post-[ — dump-mode footer at
      // ~4898 wires editorStatus, confirming v is meant to stay live.
      setDumpMode(true);
      setShowAllInTranscript(true);
      event.stopImmediatePropagation();
    } else if (input === 'v') {
      // less-style: v opens the file in $VISUAL/$EDITOR. Render the full
      // transcript (same path /export uses), write to tmp, hand off.
      // openFileInExternalEditor handles alt-screen suspend/resume for
      // terminal editors; GUI editors spawn detached.
      event.stopImmediatePropagation();
      // Drop double-taps: the render is async and a second press before it
      // completes would run a second parallel render (double memory, two
      // tempfiles, two editor spawns). editorGenRef only guards
      // transcript-exit staleness, not same-session concurrency.
      if (editorRenderingRef.current) return;
      editorRenderingRef.current = true;
      // Capture generation + make a staleness-aware setter. Each write
      // checks gen (transcript exit bumps it → late writes from the
      // async render go silent).
      const gen = editorGenRef.current;
      const setStatus = (s: string): void => {
        if (gen !== editorGenRef.current) return;
        clearTimeout(editorTimerRef.current);
        setEditorStatus(s);
      };
      setStatus(`rendering ${deferredMessages.length} messages…`);
      void (async () => {
        try {
          // Width = terminal minus vim's line-number gutter (4 digits +
          // space + slack). Floor at 80. PassThrough has no .columns so
          // without this Ink defaults to 80. Trailing-space strip: right-
          // aligned timestamps still leave a flexbox spacer run at EOL.
          // eslint-disable-next-line custom-rules/prefer-use-terminal-size -- one-shot at keypress time, not a reactive render dep
          const w = Math.max(80, (process.stdout.columns ?? 80) - 6);
          const raw = await renderMessagesToPlainText(deferredMessages, tools, w);
          const text = raw.replace(/[ \t]+$/gm, '');
          const path = join(tmpdir(), `cc-transcript-${Date.now()}.txt`);
          await writeFile(path, text);
          const opened = openFileInExternalEditor(path);
          setStatus(opened ? `opening ${path}` : `wrote ${path} · no $VISUAL/$EDITOR set`);
        } catch (e) {
          setStatus(`render failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        editorRenderingRef.current = false;
        if (gen !== editorGenRef.current) return;
        editorTimerRef.current = setTimeout(s => s(''), 4000, setEditorStatus);
      })();
    }
  },
    // !searchOpen: typing 'v' or '[' in the search bar is search input, not
    // a command. No !dumpMode here — v should work after [ (the [ handler
    // guards itself inline).
    {
      isActive: screen === 'transcript' && virtualScrollActive && !searchOpen
    });

  // Fresh `less` per transcript entry. Prevents stale highlights matching
  // unrelated normal-mode text (overlay is alt-screen-global) and avoids
  // surprise n/N on re-entry. Same exit resets [ dump mode — each ctrl+o
  // entry is a fresh instance.
  const inTranscript = screen === 'transcript' && virtualScrollActive;
  useEffect(() => {
    if (!inTranscript) {
      setSearchQuery('');
      setSearchCount(0);
      setSearchCurrent(0);
      setSearchOpen(false);
      editorGenRef.current++;
      clearTimeout(editorTimerRef.current);
      setDumpMode(false);
      setEditorStatus('');
    }
  }, [inTranscript]);
  useEffect(() => {
    setHighlight(inTranscript ? searchQuery : '');
    // Clear the position-based CURRENT (yellow) overlay too. setHighlight
    // only clears the scan-based inverse. Without this, the yellow box
    // persists at its last screen coords after ctrl-c exits transcript.
    if (!inTranscript) setPositions(null);
  }, [inTranscript, searchQuery, setHighlight, setPositions]);
  const globalKeybindingProps = {
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount: messages.length,
    onEnterTranscript: handleEnterTranscript,
    onExitTranscript: handleExitTranscript,
    virtualScrollActive,
    // Bar-open is a mode (owns keystrokes — j/k type, Esc cancels).
    // Navigating (query set, bar closed) is NOT — Esc exits transcript,
    // same as less q with highlights still visible. useSearchInput
    // doesn't stopPropagation, so without this gate transcript:exit
    // would fire on the same Esc that cancels the bar (child registers
    // first, fires first, bubbles).
    searchBarOpen: searchOpen
  };

  // Use frozen lengths to slice arrays, avoiding memory overhead of cloning
  const transcriptMessages = frozenTranscriptState ? deferredMessages.slice(0, frozenTranscriptState.messagesLength) : deferredMessages;
  const transcriptStreamingToolUses = frozenTranscriptState ? streamingToolUses.slice(0, frozenTranscriptState.streamingToolUsesLength) : streamingToolUses;

  // Handle shift+up/down for teammate transcript navigation. (Non-teammate
  // background tasks are navigated via the unified footer cursor in PromptInput.)
  useBackgroundTaskNavigation();
  // Auto-exit viewing mode when teammate completes or errors
  useTeammateViewAutoExit();
  if (screen === 'transcript') {
    // Transcript-mode render is delegated to REPLTranscriptView (Etapa 5,
    // ROADMAP 11e). The same scrollRef and jumpRef instances flow through
    // as props — never recreated — so the virtual-scroll branch keeps its
    // hold over the shared scroll position. REPL retains ownership of the
    // feature('VOICE_MODE') gate; the resulting element is passed as a
    // pre-built ReactNode so the view stays voice-subsystem-agnostic.
    return <REPLTranscriptView
      scrollRef={scrollRef as unknown as React.RefObject<unknown>}
      jumpRef={jumpRef}
      disableVirtualScroll={disableVirtualScroll}
      dumpMode={dumpMode}
      transcriptMessages={transcriptMessages}
      tools={tools as unknown as unknown[]}
      renderCommands={renderCommands}
      inProgressToolUseIDs={inProgressToolUseIDs}
      conversationId={conversationId}
      screen={screen}
      agentDefinitions={agentDefinitions}
      transcriptStreamingToolUses={transcriptStreamingToolUses}
      showAllInTranscript={showAllInTranscript}
      handleOpenRateLimitOptions={handleOpenRateLimitOptions}
      isLoading={isLoading}
      streamingThinking={streamingThinking}
      onSearchMatchesChange={onSearchMatchesChange as (m: unknown) => void}
      scanElement={scanElement}
      setPositions={setPositions as (p: unknown) => void}
      toolJSX={toolJSX}
      titleIsAnimating={titleIsAnimating}
      terminalTitle={terminalTitle}
      titleDisabled={titleDisabled}
      showStatusInTerminalTab={showStatusInTerminalTab}
      globalKeybindingProps={globalKeybindingProps as unknown as Record<string, unknown>}
      voiceKeybindingSlot={feature('VOICE_MODE') ? <VoiceKeybindingHandler voiceHandleKeyEvent={voice.handleKeyEvent} stripTrailing={voice.stripTrailing} resetAnchor={voice.resetAnchor} isActive={!toolJSX?.isLocalJSXCommand} /> : null}
      onSubmit={onSubmit as (...args: unknown[]) => unknown}
      cancelRequestProps={cancelRequestProps as unknown as Record<string, unknown>}
      focusedInputDialog={focusedInputDialog}
      searchOpen={searchOpen}
      searchCount={searchCount}
      searchCurrent={searchCurrent}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      setSearchOpen={setSearchOpen}
      setSearchCount={setSearchCount}
      setSearchCurrent={setSearchCurrent}
      setHighlight={setHighlight}
      editorStatus={editorStatus}
    />;
  }

  // Get viewed agent task (inlined from selectors for explicit data flow).
  // viewedAgentTask: teammate OR local_agent — drives the boolean checks
  // below. viewedTeammateTask: teammate-only narrowed, for teammate-specific
  // field access (inProgressToolUseIDs).
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const viewedTeammateTask = viewedTask && isInProcessTeammateTask(viewedTask) ? viewedTask : undefined;
  const viewedAgentTask = viewedTeammateTask ?? (viewedTask && isLocalAgentTask(viewedTask) ? viewedTask : undefined);

  // Bypass useDeferredValue when streaming text is showing so Messages renders
  // the final message in the same frame streaming text clears. Also bypass when
  // not loading — deferredMessages only matters during streaming (keeps input
  // responsive); after the turn ends, showing messages immediately prevents a
  // jitter gap where the spinner is gone but the answer hasn't appeared yet.
  // Only reducedMotion users keep the deferred path during loading.
  const usesSyncMessages = showStreamingText || !isLoading;
  // When viewing an agent, never fall through to leader — empty until
  // bootstrap/stream fills. Closes the see-leader-type-agent footgun.
  // The display cap bounds RENDERING only. `messages` is also the array that
  // seeds the next turn's API view, so it is never cut — cutting it was a
  // prompt-cache prefix rewrite that also dropped content the model had read
  // (docs/tech/cache/context-relief-policy.md). Index-based consumers
  // (useUnseenDivider, the transcript freeze, MessageSelector) keep reading
  // the full array.
  const fullDisplayedMessages = viewedAgentTask ? viewedAgentTask.messages ?? [] : usesSyncMessages ? messages : deferredMessages;
  // Memoized so Messages' React.memo holds once the window is a fresh slice.
  const displayedMessages = useMemo(() => fullDisplayedMessages.length > MAX_DISPLAY_MESSAGES ? fullDisplayedMessages.slice(-MAX_DISPLAY_MESSAGES) : fullDisplayedMessages, [fullDisplayedMessages]);
  // Show the placeholder until the real user message appears in
  // displayedMessages. userInputOnProcessing stays set for the whole turn
  // (cleared in resetLoadingState); this length check hides it once
  // displayedMessages grows past the baseline captured at submit time.
  // Covers both gaps: before setMessages is called (processUserInput), and
  // while deferredMessages lags behind messages. Suppressed when viewing an
  // agent — displayedMessages is a different array there, and onAgentSubmit
  // doesn't use the placeholder anyway.
  const placeholderText = userInputOnProcessing && !viewedAgentTask && fullDisplayedMessages.length <= userInputBaselineRef.current ? userInputOnProcessing : undefined;
  const toolPermissionOverlay = focusedInputDialog === 'tool-permission' ? <PermissionRequest key={toolUseConfirmQueue[0]?.toolUseID} onDone={() => setToolUseConfirmQueue(([_, ...tail]) => tail)} onReject={handleQueuedCommandOnCancel} toolUseConfirm={toolUseConfirmQueue[0]!} toolUseContext={getToolUseContext(messages, messages, abortController ?? createAbortController(), mainLoopModel)} verbose={verbose} workerBadge={toolUseConfirmQueue[0]?.workerBadge} setStickyFooter={isFullscreenEnvEnabled() ? setPermissionStickyFooter : undefined} /> : null;

  // Narrow terminals: companion collapses to a one-liner that REPL stacks
  // on its own row (above input in fullscreen, below in scrollback) instead
  // of row-beside. Wide terminals keep the row layout with sprite on the right.
  const companionNarrow = transcriptCols < MIN_COLS_FOR_FULL_SPRITE;
  // Hide the sprite when PromptInput early-returns BackgroundTasksDialog.
  // The sprite sits as a row sibling of PromptInput, so the dialog's Pane
  // divider draws at useTerminalSize() width but only gets terminalWidth -
  // spriteWidth — divider stops short and dialog text wraps early. Don't
  // check footerSelection: pill FOCUS (arrow-down to tasks pill) must keep
  // the sprite visible so arrow-right can navigate to it.
  const companionVisible = !toolJSX?.shouldHidePromptInput && !focusedInputDialog && !showBashesDialog;

  // In fullscreen, ALL local-jsx slash commands float in the modal slot —
  // FullscreenLayout wraps them in an absolute-positioned bottom-anchored
  // pane (▔ divider, ModalContext). Pane/Dialog inside detect the context
  // and skip their own top-level frame. Non-fullscreen keeps the inline
  // render paths below. Commands that used to route through bottom
  // (immediate: /model, /mcp, /btw, ...) and scrollable (non-immediate:
  // /config, /theme, /diff, ...) both go here now.
  const toolJsxCentered = isFullscreenEnvEnabled() && toolJSX?.isLocalJSXCommand === true;
  const centeredModal: React.ReactNode = toolJsxCentered ? toolJSX!.jsx : null;

  // <AlternateScreen> at the root: everything below is inside its
  // <Box height={rows}>. Handlers/contexts are zero-height so ScrollBox's
  // flexGrow in FullscreenLayout resolves against this Box. The transcript
  // early return above wraps its virtual-scroll branch the same way; only
  // the 30-cap dump branch stays unwrapped for native terminal scrollback.
  const mainReturn = <KeybindingSetup>
    <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={terminalTitle} disabled={titleDisabled} noPrefix={showStatusInTerminalTab} />
    <GlobalKeybindingHandlers {...globalKeybindingProps} />
    {feature('VOICE_MODE') ? <VoiceKeybindingHandler voiceHandleKeyEvent={voice.handleKeyEvent} stripTrailing={voice.stripTrailing} resetAnchor={voice.resetAnchor} isActive={!toolJSX?.isLocalJSXCommand} /> : null}
    <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
    {/* ScrollKeybindingHandler must mount before CancelRequestHandler so
          ctrl+c-with-selection copies instead of cancelling the active task.
          Its raw useInput handler only stops propagation when a selection
          exists — without one, ctrl+c falls through to CancelRequestHandler.
          PgUp/PgDn/wheel always scroll the transcript behind the modal —
          the modal's inner ScrollBox is not keyboard-driven. onScroll
          stays suppressed while a modal is showing so scroll doesn't
          stamp divider/pill state. */}
    <ScrollKeybindingHandler scrollRef={scrollRef} isActive={isFullscreenEnvEnabled() && (centeredModal != null || !focusedInputDialog || focusedInputDialog === 'tool-permission')} onScroll={centeredModal || toolPermissionOverlay || viewedAgentTask ? undefined : composedOnScroll} />
    {feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions ? <MessageActionsKeybindings handlers={messageActionHandlers} isActive={cursor !== null} /> : null}
    <CancelRequestHandler {...cancelRequestProps} />
    <MCPConnectionManager key={remountKey} dynamicMcpConfig={dynamicMcpConfig} isStrictMcpConfig={strictMcpConfig}>
      <FullscreenLayout scrollRef={scrollRef} overlay={toolPermissionOverlay} bottomFloat={isBuddyEnabled() && companionVisible && !companionNarrow ? <CompanionFloatingBubble /> : undefined} modal={centeredModal} modalScrollRef={modalScrollRef} dividerYRef={dividerYRef} hidePill={!!viewedAgentTask} hideSticky={!!viewedTeammateTask} newMessageCount={unseenDivider?.count ?? 0} onPillClick={() => {
        setCursor(null);
        jumpToNew(scrollRef.current);
      }} scrollable={<>
        {/* Render the startup banner inside Ink so it scrolls naturally
                  into scrollback as content grows (non-fullscreen) or commits
                  to the alt-screen (fullscreen). Writing it via stdout before
                  Ink mounts caused fullReset to wipe it on the first keystroke. */}
        <StartupBanner />
        <TeammateViewHeader />
        <Messages messages={displayedMessages} tools={tools} commands={renderCommands} verbose={verbose} toolJSX={toolJSX} toolUseConfirmQueue={toolUseConfirmQueue} inProgressToolUseIDs={viewedTeammateTask ? viewedTeammateTask.inProgressToolUseIDs ?? new Set() : inProgressToolUseIDs} isMessageSelectorVisible={isMessageSelectorVisible} conversationId={conversationId} screen={screen} streamingToolUses={streamingToolUses} showAllInTranscript={showAllInTranscript} agentDefinitions={agentDefinitions} onOpenRateLimitOptions={handleOpenRateLimitOptions} isLoading={isLoading} hasStreamingText={isLoading && !viewedAgentTask && hasVisibleStreamingText} isBriefOnly={viewedAgentTask ? false : isBriefOnly} unseenDivider={viewedAgentTask ? undefined : unseenDivider} scrollRef={isFullscreenEnvEnabled() ? scrollRef : undefined} trackStickyPrompt={isFullscreenEnvEnabled() ? true : undefined} cursor={cursor} setCursor={setCursor} cursorNavRef={cursorNavRef} />
        <AwsAuthStatusBox />
        {/* Hide the processing placeholder while a modal is showing —
                  it would sit at the last visible transcript row right above
                  the ▔ divider, showing "❯ /config" as redundant clutter
                  (the modal IS the /config UI). Outside modals it stays so
                  the user sees their input echoed while Claude processes. */}
        {!disabled && placeholderText && !centeredModal && <UserTextMessage param={{
          text: placeholderText,
          type: 'text'
        }} addMargin={true} verbose={verbose} />}
        {toolJSX && !(toolJSX.isLocalJSXCommand && toolJSX.isImmediate) && !toolJsxCentered && <Box flexDirection="column" width="100%">
          {toolJSX.jsx}
        </Box>}
        {feature('WEB_BROWSER_TOOL') ? WebBrowserPanelModule && <WebBrowserPanelModule.WebBrowserPanel /> : null}
        <REPLStatus showSpinner={showSpinner} streamMode={streamMode} spinnerTip={spinnerTip} responseLengthRef={responseLengthRef} apiMetricsRef={apiMetricsRef} spinnerMessage={spinnerMessage} stopHookSpinnerSuffix={stopHookSpinnerSuffix} verbose={verbose} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} pauseStartTimeRef={pauseStartTimeRef} spinnerColor={spinnerColor} spinnerShimmerColor={spinnerShimmerColor} hasActiveTools={inProgressToolUseIDs.size > 0} leaderIsIdle={!isLoading} isLoading={isLoading} userInputOnProcessing={userInputOnProcessing} hasRunningTeammates={hasRunningTeammates} isBriefOnly={isBriefOnly} viewedAgentTask={viewedAgentTask} />
      </>} bottom={<Box flexDirection={isBuddyEnabled() && companionNarrow ? 'column' : 'row'} width="100%" alignItems={isBuddyEnabled() && companionNarrow ? undefined : 'flex-end'}>
        {isBuddyEnabled() && companionNarrow && isFullscreenEnvEnabled() && companionVisible ? <CompanionSprite /> : null}
        <Box flexDirection="column" flexGrow={1}>
          {permissionStickyFooter}
          {/* Immediate local-jsx commands (/btw, /sandbox, /assistant,
                  /issue) render here, NOT inside scrollable. They stay mounted
                  while the main conversation streams behind them, so ScrollBox
                  relayouts on each new message would drag them around. bottom
                  is flexShrink={0} outside the ScrollBox — it never moves.
                  Non-immediate local-jsx (/diff, /status, /theme, ~40 others)
                  stays in scrollable: the main loop is paused so no jiggle,
                  and any with tall content that isn't windowed to a fixed
                  height needs the outer ScrollBox. */}
          {toolJSX?.isLocalJSXCommand && toolJSX.isImmediate && !toolJsxCentered && <Box flexDirection="column" width="100%">
            {toolJSX.jsx}
          </Box>}
          {!showSpinner && !toolJSX?.isLocalJSXCommand && showExpandedTodos && tasksV2 && tasksV2.length > 0 && <Box width="100%" flexDirection="column">
            <TaskListV2 tasks={tasksV2} isStandalone={true} />
          </Box>}
          {renderREPLDialogs({
            focusedInputDialog,
            sandboxPermissionRequestQueue,
            setSandboxPermissionRequestQueue: setSandboxPermissionRequestQueue as unknown as React.Dispatch<React.SetStateAction<unknown[]>>,
            sandboxBridgeCleanupRef,
            promptQueue: promptQueue as unknown as Parameters<typeof renderREPLDialogs>[0]['promptQueue'],
            setPromptQueue: setPromptQueue as unknown as React.Dispatch<React.SetStateAction<unknown[]>>,
            pendingWorkerRequest,
            pendingSandboxRequest,
            workerSandboxPermissions,
            teamContext,
            setAppState: setAppState as unknown as (updater: (prev: unknown) => unknown) => void,
            elicitation: elicitation as unknown as Parameters<typeof renderREPLDialogs>[0]['elicitation'],
            setShowCostDialog,
            setHaveShownCostDialog,
            idleReturnPending,
            setIdleReturnPending,
            getTotalInputTokens,
            messagesRef: messagesRef as unknown as React.RefObject<unknown[]>,
            setInputValue,
            setMessages: setMessages as unknown as (m: unknown) => void,
            readFileState,
            discoveredSkillNamesRef,
            loadedNestedMemoryPathsRef,
            store,
            // renderREPLDialogs wants a plain `(id: string) => void`; the
            // local state setter is narrowed to the crypto UUID template type.
            setConversationId: (id: string) => setConversationId(id as UUID),
            haikuTitleAttemptedRef,
            setHaikuTitle,
            bashTools: bashTools as unknown as React.RefObject<{ clear: () => void }>,
            bashToolsProcessedIdx,
            skipIdleCheckRef,
            onSubmitRef: onSubmitRef as unknown as React.RefObject<(input: string, helpers: { setCursorOffset: () => void; clearBuffer: () => void; resetHistory: () => void }) => unknown>,
            setShowIdeOnboarding,
            ideInstallationStatus,
            mainLoopModel,
            setShowEffortCallout,
            exitFlow,
            hintRecommendation,
            handleHintResponse,
            setShowDesktopUpsellStartup,
            ultraplanPendingChoice: ultraplanPendingChoice ?? null,
            ultraplanLaunchPending: ultraplanLaunchPending ?? null,
            queryGuard,
            createAbortController,
            createCommandInputMessage,
            formatCommandInputTags,
            escapeXml,
            LOCAL_COMMAND_STDOUT_TAG,
            // ULTRAPLAN is dead in the open build (feature flag off); the
            // identifier `launchUltraplan` is never imported here, so a
            // direct reference would ReferenceError at unbundled (test) eval
            // time. The matching slot below is `null`, so the renderer's
            // feature() gate short-circuits before this is ever called.
            launchUltraplan: (() => Promise.resolve('')) as unknown as Parameters<typeof renderREPLDialogs>[0]['launchUltraplan'],
          }, {
            SandboxPermissionRequest,
            IdeOnboardingDialog: IdeOnboardingDialog as unknown as Parameters<typeof renderREPLDialogs>[1]['IdeOnboardingDialog'],
            EffortCallout: EffortCallout as unknown as Parameters<typeof renderREPLDialogs>[1]['EffortCallout'],
            RemoteCallout,
            PluginHintMenu,
            DesktopUpsellStartup,
            // ULTRAPLAN feature is disabled in the open build; both dialogs
            // are referenced symbolically (never imported) inside the
            // feature() ternary. Pass null so the slot type stays sound and
            // the render function's feature gate short-circuits identically.
            UltraplanChoiceDialog: null,
            UltraplanLaunchDialog: null,
          })}

          {mrRender()}

          {!toolJSX?.shouldHidePromptInput && !focusedInputDialog && !isExiting && !disabled && !cursor && !isShuttingDown() && <>
            {autoRunIssueReason && <AutoRunIssueNotification onRun={handleAutoRunIssue} onCancel={handleCancelAutoRunIssue} reason={getAutoRunIssueReasonText(autoRunIssueReason)} />}
            {postCompactSurvey.state !== 'closed' ? <FeedbackSurvey state={postCompactSurvey.state} lastResponse={postCompactSurvey.lastResponse} handleSelect={postCompactSurvey.handleSelect} inputValue={inputValue} setInputValue={setInputValue} onRequestFeedback={handleSurveyRequestFeedback} /> : memorySurvey.state !== 'closed' ? <FeedbackSurvey state={memorySurvey.state} lastResponse={memorySurvey.lastResponse} handleSelect={memorySurvey.handleSelect} handleTranscriptSelect={memorySurvey.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} onRequestFeedback={handleSurveyRequestFeedback} message="How well did Claude use its memory? (optional)" /> : <FeedbackSurvey state={feedbackSurvey.state} lastResponse={feedbackSurvey.lastResponse} handleSelect={feedbackSurvey.handleSelect} handleTranscriptSelect={feedbackSurvey.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} onRequestFeedback={didAutoRunIssueRef.current ? undefined : handleSurveyRequestFeedback} />}
            {/* Frustration-triggered transcript sharing prompt */}
            {frustrationDetection.state !== 'closed' && <FeedbackSurvey state={frustrationDetection.state} lastResponse={null} handleSelect={() => { }} handleTranscriptSelect={frustrationDetection.handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} />}
            {showIssueFlagBanner && <IssueFlagBanner />}
            { }
            <PromptInput debug={debug} ideSelection={ideSelection} hasSuppressedDialogs={!!hasSuppressedDialogs} isLocalJSXCommandActive={isShowingLocalJSXCommand} getToolUseContext={getToolUseContext} toolPermissionContext={toolPermissionContext} setToolPermissionContext={setToolPermissionContext} apiKeyStatus={apiKeyStatus} commands={renderCommands} agents={agentDefinitions.activeAgents} isLoading={isLoading} onExit={handleExit} verbose={verbose} messages={messages} onAutoUpdaterResult={setAutoUpdaterResult} autoUpdaterResult={autoUpdaterResult} input={inputValue} onInputChange={setInputValue} mode={inputMode} onModeChange={setInputMode} stashedPrompt={stashedPrompt} setStashedPrompt={setStashedPrompt} submitCount={submitCount} onShowMessageSelector={handleShowMessageSelector} onMessageActionsEnter={
              // Works during isLoading — edit cancels first; uuid selection survives appends.
              feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions ? enterMessageActions : undefined} mcpClients={mcpClients} pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode} setVimMode={setVimMode} showBashesDialog={showBashesDialog} setShowBashesDialog={setShowBashesDialog} showWorkflowsDialog={showWorkflowsDialog} setShowWorkflowsDialog={setShowWorkflowsDialog} onSubmit={onSubmit} onAgentSubmit={onAgentSubmit} isSearchingHistory={isSearchingHistory} setIsSearchingHistory={setIsSearchingHistory} helpOpen={isHelpOpen} setHelpOpen={setIsHelpOpen} insertTextRef={feature('VOICE_MODE') ? insertTextRef : undefined} voiceInterimRange={voice.interimRange} />
            <SessionBackgroundHint onBackgroundSession={handleBackgroundSession} isLoading={isLoading} />
          </>}
          {cursor &&
            // inputValue is REPL state; typed text survives the round-trip.
            <MessageActionsBar cursor={cursor} />}
          {focusedInputDialog === 'message-selector' && <MessageSelector messages={messages} preselectedMessage={messageSelectorPreselect} onPreRestore={onCancel} onRestoreCode={async (message: UserMessage) => {
            await fileHistoryRewind((updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory)
              }));
            }, message.uuid);
          }} onSummarize={async (message: UserMessage, feedback?: string, direction: PartialCompactDirection = 'from') => {
            // Project snipped messages so the compact model
            // doesn't summarize content that was intentionally removed.
            const compactMessages = getMessagesAfterCompactBoundary(messages);
            const messageIndex = compactMessages.indexOf(message);
            if (messageIndex === -1) {
              // Selected a snipped or pre-compact message that the
              // selector still shows (REPL keeps full history for
              // scrollback). Surface why nothing happened instead
              // of silently no-oping.
              setMessages(prev => [...prev, createSystemMessage('That message is no longer in the active context (snipped or pre-compact). Choose a more recent message.', 'warning')]);
              return;
            }
            const newAbortController = createAbortController();
            const context = getToolUseContext(compactMessages, [], newAbortController, mainLoopModel);
            const appState = context.getAppState();
            const defaultSysPrompt = await getSystemPrompt(context.options.tools, context.options.mainLoopModel, Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys()), context.options.mcpClients);
            const systemPrompt = buildEffectiveSystemPrompt({
              mainThreadAgentDefinition: undefined,
              toolUseContext: context,
              customSystemPrompt: context.options.customSystemPrompt,
              defaultSystemPrompt: defaultSysPrompt,
              appendSystemPrompt: context.options.appendSystemPrompt
            });
            const [userContext, systemContext] = await Promise.all([getUserContext(), getSystemContext()]);
            const result = await partialCompactConversation(compactMessages, messageIndex, context, {
              systemPrompt,
              userContext,
              systemContext,
              toolUseContext: context,
              forkContextMessages: compactMessages
            }, feedback, direction);
            const kept = result.messagesToKeep ?? [];
            const ordered = direction === 'up_to' ? [...result.summaryMessages, ...kept] : [...kept, ...result.summaryMessages];
            const postCompact = [result.boundaryMarker, ...ordered, ...result.attachments, ...result.hookResults];
            // Fullscreen 'from' keeps scrollback; 'up_to' must not
            // (old[0] unchanged + grown array means incremental
            // useLogMessages path, so boundary never persisted).
            // Find by uuid since old is raw REPL history and snipped
            // entries can shift the projected messageIndex.
            if (isFullscreenEnvEnabled() && direction === 'from') {
              setMessages(old => {
                const rawIdx = old.findIndex(m => m.uuid === message.uuid);
                return [...old.slice(0, rawIdx === -1 ? 0 : rawIdx), ...postCompact];
              });
            } else {
              setMessages(postCompact);
            }
            // Partial compact bypasses handleMessageFromStream — clear
            // the context-blocked flag so proactive ticks resume.
            if (feature('PROACTIVE') || feature('KAIROS')) {
              proactiveModule?.setContextBlocked(false);
            }
            setConversationId(randomUUID());
            runPostCompactCleanup(context.options.querySource, postCompact, contentReplacementStateRef.current);
            if (direction === 'from') {
              const r = textForResubmit(message);
              if (r) {
                setInputValue(r.text);
                setInputMode(r.mode);
              }
            }

            // Show notification with ctrl+o hint
            const historyShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
            addNotification({
              key: 'summarize-ctrl-o-hint',
              text: `Conversation summarized (${historyShortcut} for history)`,
              priority: 'medium',
              timeoutMs: 8000
            });
          }} onRestoreMessage={handleRestoreMessage} onClose={() => {
            setIsMessageSelectorVisible(false);
            setMessageSelectorPreselect(undefined);
          }} />}
        </Box>
        {isBuddyEnabled() && !(companionNarrow && isFullscreenEnvEnabled()) && companionVisible ? <CompanionSprite /> : null}
      </Box>} />
    </MCPConnectionManager>
  </KeybindingSetup>;
  if (isFullscreenEnvEnabled()) {
    return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
      {mainReturn}
    </AlternateScreen>;
  }
  return mainReturn;
}
