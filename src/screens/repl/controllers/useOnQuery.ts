// Owns the query controller trio: `onQueryEvent` (stream-event fan-out into
// messages / streaming state), `onQueryImpl` (context assembly, the query loop,
// post-turn pruning) and `onQuery` (the concurrency guard, turn timing, and the
// finally block that reports duration, cache stats and auto-restore).
//
// Extracted from src/screens/REPL.tsx (controllers, ROADMAP 11e deferred half).
// Before extraction these three `useCallback`s sat consecutively between
// `useSessionBackgrounding(...)` and the initial-message effect, in this order:
// onQueryEvent, onQueryImpl, onQuery. Nothing sat between them.
//
// IMPORTANT - hook order: REPL.tsx invokes `useOnQuery(...)` at exactly the
// position `onQueryEvent` occupied, and this file calls the same three
// `useCallback`s in the same order with verbatim dependency arrays. The
// component's hook-call sequence is unchanged.
//
// Two indirections here are load-bearing and must not be "simplified":
//   * `restoreMessageSyncRef` - the auto-restore path at the bottom of onQuery's
//     finally block reaches `restoreMessageSync` through a ref because that
//     callback is declared LATER in the component. Calling it directly would be a
//     temporal-dead-zone crash. The ref is written during render by
//     useMessageActionsController.
//   * `queryGuard.end(thisGeneration)` returning false is not an error path. The
//     cancel path calls `forceEnd()`, which bumps the generation, so a stale
//     finally from a superseded turn skips the whole end-of-turn block - that is
//     how cancel+resubmit avoids double-counting wall time. The auto-restore
//     block deliberately sits OUTSIDE that check for the same reason.

import { useCallback } from 'react';
import type { UUID } from 'crypto';
import type { CanUseToolFn } from '../../../hooks/useCanUseTool.js';
import type { createCoalescedUpdater } from '../../../utils/coalescedUpdater.js';
import type { SpinnerMode } from '../../../components/Spinner.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import type { MCPServerConnection } from '../../../services/mcp/types.js';
import type { useAppStateStore } from '../../../state/AppState.js';
import type { provisionContentReplacementState } from '../../../utils/toolResultStorage.js';
import { feature } from 'bun:bundle';
import { snapshotOutputTokensForTurn, getCurrentTurnTokenBudget, getTurnOutputTokens, getBudgetContinuationCount } from '../../../bootstrap/state.js';
import { parseTokenBudget } from '../../../utils/tokenBudget.js';
import { count } from '../../../utils/array.js';
import { markTurnStart, markTurnEnd, resetTurnHookDuration, resetTurnToolDuration, resetTurnClassifierDuration } from '../../../bootstrap/state.js';
import { QueryGuard } from '../../../utils/QueryGuard.js';
import { setMemberActive } from '../../../utils/swarm/teamHelpers.js';
import { getTeamName, getAgentName } from '../../../utils/teammate.js';
import { getAllInProcessTeammateTasks } from '../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { selectableUserMessagesFilter, messagesAfterAreOnlySynthetic } from '../../../components/MessageSelector.js';
import { streamingTextStore } from '../../../hooks/useStreamingTextStore.js';
import { getSystemPrompt } from '../../../constants/prompts.js';
import { buildEffectiveSystemPrompt } from '../../../utils/systemPrompt.js';
import { getSystemContext, getUserContext } from '../../../context.js';
import { removeLastFromHistory } from '../../../history.js';
import { getScratchpadDir, isScratchpadEnabled } from '../../../utils/permissions/filesystem.js';
import { getGlobalConfig } from '../../../utils/config.js';
import { logEvent } from 'src/services/analytics/index.js';
import { handleMessageFromStream, type StreamingToolUse, type StreamingThinking, isCompactBoundaryMessage, getMessagesAfterCompactBoundary, getContentText, createTurnDurationMessage, createSystemMessage } from '../../../utils/messages.js';
import { getCurrentTurnCacheMetrics, resetCurrentTurn } from '../../../services/api/cacheStatsTracker.js';
import { formatCacheMetricsCompact, formatCacheMetricsFull } from '../../../services/api/cacheMetrics.js';
import { generateSessionTitle } from '../../../utils/sessionTitle.js';
import { BASH_INPUT_TAG, COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../../../constants/xml.js';
import { queryCheckpoint, logQueryProfileReport } from '../../../utils/queryProfiler.js';
import type { Message as MessageType, UserMessage } from '../../../types/message.js';
import { query } from '../../../query.js';
import { mergeClients } from '../../../hooks/useMergedClients.js';
import { getQuerySourceForREPL } from '../../../utils/promptCategory.js';
import { maybeMarkProjectOnboardingComplete } from '../../../projectOnboardingState.js';
import { randomUUID } from 'crypto';
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js';
import type { ProcessUserInputContext } from '../../../utils/processUserInput/processUserInput.js';
import { removeTranscriptMessage, isEphemeralToolProgress, isLoggableMessage } from '../../../utils/sessionStorage.js';
import { applyStableStubs, pruneOldToolResults, pruneToolResultsByBytes, evictOldStubbedMessages, evictToMaxSize, pruneContentReplacementState, stubToolResultForDisplay, EVICT_MIN_BATCH, EVICT_TRIGGER_AT, MAX_DISPLAY_MESSAGES, type AnyMessage } from '../../../services/compact/stableStubState.js';
import { notifyCacheDeletion } from '../../../services/api/promptCacheBreakDetection.js';
import { getCacheProfile } from '../../../services/cache/cacheProfile.js';
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js';
import { closeOpenDiffs, getConnectedIdeClient } from '../../../utils/ide.js';
import { enqueue, type SetAppState, getCommandQueueLength } from '../../../utils/messageQueueManager.js';
import { diagnosticTracker } from '../../../services/diagnosticTracking.js';
import type { EffortValue } from '../../../utils/effort.js';
import { checkAndDisableBypassPermissionsIfNeeded, checkAndDisableAutoModeIfNeeded } from 'src/utils/permissions/bypassPermissionsKillswitch.js';
import { isBuddyEnabled } from '../../../buddy/feature.js';
import { fireCompanionObserver } from '../../../buddy/observer.js';
import { isFullscreenEnvEnabled } from '../../../utils/fullscreen.js';

// Mirrors the module-level bindings in REPL.tsx. `feature()` must sit DIRECTLY in
// a ternary condition - the build folds it in place and any other form throws.
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../../../proactive/index.js') : null;
const getCoordinatorUserContext: (mcpClients: ReadonlyArray<{
  name: string;
}>, scratchpadDir?: string) => {
  [k: string]: string;
} = feature('COORDINATOR_MODE') ? require('../../../coordinator/coordinatorMode.js').getCoordinatorUserContext : () => ({});
/* eslint-enable @typescript-eslint/no-require-imports */

export interface UseOnQueryDeps {
  // --- context assembly
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext;
  canUseTool: CanUseToolFn;
  queryGuard: QueryGuard;
  store: ReturnType<typeof useAppStateStore>;
  toolPermissionContext: ToolPermissionContext;
  initialMcpClients: MCPServerConnection[] | undefined;
  mainThreadAgentDefinition: AgentDefinition | undefined;
  customSystemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>;
  // --- session title
  sessionTitle: string | undefined;
  agentTitle: string | undefined;
  titleDisabled: boolean;
  setHaikuTitle: React.Dispatch<React.SetStateAction<string | undefined>>;
  haikuTitleAttemptedRef: React.RefObject<boolean>;
  // --- more-right recorder
  mrOnBeforeQuery: (input: string, messages: MessageType[], newMessageCount: number) => Promise<boolean>;
  mrOnTurnComplete: (messages: MessageType[], aborted: boolean) => Promise<void>;
  // --- streaming plumbing
  coalescedStreamingToolUses: ReturnType<typeof createCoalescedUpdater<StreamingToolUse[]>>;
  onStreamingText: (f: (current: string | null) => string | null) => void;
  setStreamingThinking: React.Dispatch<React.SetStateAction<StreamingThinking | null>>;
  setStreamingToolUses: React.Dispatch<React.SetStateAction<StreamingToolUse[]>>;
  setStreamMode: React.Dispatch<React.SetStateAction<SpinnerMode>>;
  setResponseLength: (f: (prev: number) => number) => void;
  // --- refs (stable; intentionally absent from the dep arrays)
  messagesRef: React.RefObject<MessageType[]>;
  inputValueRef: React.RefObject<string>;
  restoreMessageSyncRef: React.RefObject<(m: UserMessage) => void>;
  sendBridgeResultRef: React.RefObject<() => void>;
  contentReplacementStateRef: { current: ReturnType<typeof provisionContentReplacementState> };
  responseLengthRef: React.RefObject<number>;
  apiMetricsRef: React.RefObject<Array<{
    ttftMs: number;
    firstTokenTime: number;
    lastTokenTime: number;
    responseLengthBaseline: number;
    endResponseLength: number;
  }>>;
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  swarmStartTimeRef: React.RefObject<number | null>;
  swarmBudgetInfoRef: React.RefObject<{ tokens: number; limit: number; nudges: number } | undefined>;
  terminalFocusRef: React.RefObject<boolean>;
  skipIdleCheckRef: React.RefObject<boolean>;
  // --- misc state
  // `unknown` mirrors REPL.tsx: useSyncExternalStore over the untyped
  // proactiveModule yields unknown, and the body only uses it in `!` position.
  proactiveActive: unknown;
  // --- setters
  setMessages: (action: React.SetStateAction<MessageType[]>) => void;
  setAppState: SetAppState;
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>;
  setConversationId: React.Dispatch<React.SetStateAction<UUID>>;
  setLastQueryCompletionTime: React.Dispatch<React.SetStateAction<number>>;
  resetLoadingState: () => void;
  resetTimingRefs: () => void;
}

export type OnQuery = (
  newMessages: MessageType[],
  abortController: AbortController,
  shouldQuery: boolean,
  additionalAllowedTools: string[],
  mainLoopModelParam: string,
  onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>,
  input?: string,
  effort?: EffortValue,
) => Promise<void>;

export function useOnQuery(deps: UseOnQueryDeps): { onQuery: OnQuery } {
  const {
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
  } = deps;

  const onQueryEvent = useCallback((event: Parameters<typeof handleMessageFromStream>[0]) => {
    handleMessageFromStream(event, newMessage => {
      // Apply any frame-coalesced streamingToolUses updates queued before this
      // message (including the message_stop `() => []` reset) in the same task
      // as the setMessages below, so React auto-batches both into one commit
      // (the LegacyRoot tag is vestigial — react-reconciler 0.33 runs every
      // root in ConcurrentMode) and the streaming-preview → final-message
      // switch never paints an intermediate frame. Ink's throttled stdout
      // paint is a second, independent net.
      coalescedStreamingToolUses.flush();
      if (isCompactBoundaryMessage(newMessage)) {
        // Fullscreen: keep pre-compact messages for scrollback. query.ts
        // slices at the boundary for API calls, Messages.tsx skips the
        // boundary filter in fullscreen, and useLogMessages treats this
        // as an incremental append (first uuid unchanged). Cap at one
        // compact-interval of scrollback — normalizeMessages/applyGrouping
        // are O(n) per render, so drop everything before the previous
        // boundary to keep n bounded across multi-day sessions.
        if (isFullscreenEnvEnabled()) {
          setMessages(old => [...getMessagesAfterCompactBoundary(old, {
            includeSnipped: true
          }), newMessage]);
        } else {
          setMessages(() => [newMessage]);
        }
        // Bump conversationId so Messages.tsx row keys change and
        // stale memoized rows remount with post-compact content.
        setConversationId(randomUUID());
        // Compaction succeeded — clear the context-blocked flag so ticks resume
        if (feature('PROACTIVE') || feature('KAIROS')) {
          proactiveModule?.setContextBlocked(false);
        }
      } else if (newMessage.type === 'progress' && isEphemeralToolProgress(newMessage.data.type)) {
        // Replace the previous ephemeral progress tick for the same tool
        // call instead of appending. Sleep/Bash emit a tick per second and
        // only the last one is rendered; appending blows up the messages
        // array (13k+ observed) and the transcript (120MB of sleep_progress
        // lines). useLogMessages tracks length, so same-length replacement
        // also skips the transcript write.
        // agent_progress / hook_progress / skill_progress are NOT ephemeral
        // — each carries distinct state the UI needs (e.g. subagent tool
        // history). Replacing those leaves the AgentTool UI stuck at
        // "Initializing…" because it renders the full progress trail.
        setMessages(oldMessages => {
          const last = oldMessages.at(-1);
          if (last?.type === 'progress' && last.parentToolUseID === newMessage.parentToolUseID && last.data.type === newMessage.data.type) {
            const copy = oldMessages.slice();
            copy[copy.length - 1] = newMessage;
            return copy;
          }
          return [...oldMessages, newMessage];
        });
      } else {
        // Immediately stub large tool_results for display to prevent
        // mid-turn memory spikes. Full content is preserved in
        // QueryEngine.mutableMessages (API-facing) and transcript.
        const displayProfile = getCacheProfile()
        const displayMessage = stubToolResultForDisplay(newMessage, messagesRef.current as AnyMessage[], displayProfile.immediateStubTokens, displayProfile.stubKeepHeadChars)
        setMessages(oldMessages => [...oldMessages, displayMessage]);
      }
      // Block ticks on API errors to prevent tick → error → tick
      // runaway loops (e.g., auth failure, rate limit, blocking limit).
      // Cleared on compact boundary (above) or successful response (below).
      if (feature('PROACTIVE') || feature('KAIROS')) {
        if (newMessage.type === 'assistant' && 'isApiErrorMessage' in newMessage && newMessage.isApiErrorMessage) {
          proactiveModule?.setContextBlocked(true);
        } else if (newMessage.type === 'assistant') {
          proactiveModule?.setContextBlocked(false);
        }
      }
    }, newContent => {
      // setResponseLength handles updating both responseLengthRef (for
      // spinner animation) and apiMetricsRef (endResponseLength/lastTokenTime
      // for OTPS). No separate metrics update needed here.
      setResponseLength(length => length + newContent.length);
    }, setStreamMode, coalescedStreamingToolUses.enqueue, tombstonedMessage => {
      // Filter by uuid, not reference: query.ts yields a backfilled clone of
      // each assistant message (tool_use input backfill), so the array entry
      // can be a different object than the tombstoned original.
      setMessages(oldMessages => oldMessages.filter(m => m.uuid !== tombstonedMessage.uuid));
      void removeTranscriptMessage(tombstonedMessage.uuid);
    }, setStreamingThinking, metrics => {
      const now = Date.now();
      const baseline = responseLengthRef.current;
      apiMetricsRef.current.push({
        ...metrics,
        firstTokenTime: now,
        lastTokenTime: now,
        responseLengthBaseline: baseline,
        endResponseLength: baseline
      });
    }, onStreamingText);
  }, [setMessages, setResponseLength, setStreamMode, coalescedStreamingToolUses, setStreamingThinking, onStreamingText]);
  const onQueryImpl = useCallback(async (messagesIncludingNewMessages: MessageType[], newMessages: MessageType[], abortController: AbortController, shouldQuery: boolean, additionalAllowedTools: string[], mainLoopModelParam: string, effort?: EffortValue) => {
    // Prepare IDE integration for new prompt. Read mcpClients fresh from
    // store — useManageMCPConnections may have populated it since the
    // render that captured this closure (same pattern as computeTools).
    if (shouldQuery) {
      const freshClients = mergeClients(initialMcpClients, store.getState().mcp.clients);
      void diagnosticTracker.handleQueryStart(freshClients);
      const ideClient = getConnectedIdeClient(freshClients);
      if (ideClient) {
        void closeOpenDiffs(ideClient);
      }
    }

    // Mark onboarding as complete when any user message is sent to Claude
    void maybeMarkProjectOnboardingComplete();

    // Extract a session title from the first real user message. One-shot
    // via ref (was tengu_birch_mist experiment: first-message-only to save
    // Haiku calls). The ref replaces the old `messages.length <= 1` check,
    // which was broken by SessionStart hook messages (prepended via
    // useDeferredHookMessages) and attachment messages (appended by
    // processTextPrompt) — both pushed length past 1 on turn one, so the
    // title silently fell through to the "Claude Code" default.
    if (!titleDisabled && !sessionTitle && !agentTitle && !haikuTitleAttemptedRef.current) {
      const firstUserMessage = newMessages.find(m => m.type === 'user' && !m.isMeta);
      const text = firstUserMessage?.type === 'user' ? getContentText(firstUserMessage.message.content) : null;
      // Skip synthetic breadcrumbs — slash-command output, prompt-skill
      // expansions (/commit → <command-message>), local-command headers
      // (/help → <command-name>), and bash-mode (!cmd → <bash-input>).
      // None of these are the user's topic; wait for real prose.
      if (text && !text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) && !text.startsWith(`<${COMMAND_MESSAGE_TAG}>`) && !text.startsWith(`<${COMMAND_NAME_TAG}>`) && !text.startsWith(`<${BASH_INPUT_TAG}>`)) {
        haikuTitleAttemptedRef.current = true;
        void generateSessionTitle(text, new AbortController().signal).then(title => {
          if (title) setHaikuTitle(title); else haikuTitleAttemptedRef.current = false;
        }, () => {
          haikuTitleAttemptedRef.current = false;
        });
      }
    }

    // Apply slash-command-scoped allowedTools (from skill frontmatter) to the
    // store once per turn. This also covers the reset: the next non-skill turn
    // passes [] and clears it. Must run before the !shouldQuery gate: forked
    // commands (executeForkedSlashCommand) return shouldQuery=false, and
    // createGetAppStateWithAllowedTools in forkedAgent.ts reads this field, so
    // stale skill tools would otherwise leak into forked agent permissions.
    // Previously this write was hidden inside getToolUseContext's getAppState
    // (~85 calls/turn); hoisting it here makes getAppState a pure read and stops
    // ephemeral contexts (permission dialog, BackgroundTasksDialog) from
    // accidentally clearing it mid-turn.
    store.setState(prev => {
      const cur = prev.toolPermissionContext.alwaysAllowRules.command;
      if (cur === additionalAllowedTools || cur?.length === additionalAllowedTools.length && cur.every((v, i) => v === additionalAllowedTools[i])) {
        return prev;
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          alwaysAllowRules: {
            ...prev.toolPermissionContext.alwaysAllowRules,
            command: additionalAllowedTools
          }
        }
      };
    });

    // The last message is an assistant message if the user input was a bash command,
    // or if the user input was an invalid slash command.
    if (!shouldQuery) {
      // Manual /compact sets messages directly (shouldQuery=false) bypassing
      // handleMessageFromStream. Clear context-blocked if a compact boundary
      // is present so proactive ticks resume after compaction.
      if (newMessages.some(isCompactBoundaryMessage)) {
        // Bump conversationId so Messages.tsx row keys change and
        // stale memoized rows remount with post-compact content.
        setConversationId(randomUUID());
        if (feature('PROACTIVE') || feature('KAIROS')) {
          proactiveModule?.setContextBlocked(false);
        }
      }
      resetLoadingState();
      setAbortController(null);
      return;
    }
    const toolUseContext = getToolUseContext(messagesIncludingNewMessages, newMessages, abortController, mainLoopModelParam);
    // getToolUseContext reads tools/mcpClients fresh from store.getState()
    // (via computeTools/mergeClients). Use those rather than the closure-
    // captured `tools`/`mcpClients` — useManageMCPConnections may have
    // flushed new MCP state between the render that captured this closure
    // and now. Turn 1 via processInitialMessage is the main beneficiary.
    const {
      tools: freshTools,
      mcpClients: freshMcpClients
    } = toolUseContext.options;

    // Scope the skill's effort override to this turn's context only —
    // wrapping getAppState keeps the override out of the global store so
    // background agents and UI subscribers (Spinner, LogoV2) never see it.
    if (effort !== undefined) {
      const previousGetAppState = toolUseContext.getAppState;
      toolUseContext.getAppState = () => ({
        ...previousGetAppState(),
        effortValue: effort
      });
    }
    queryCheckpoint('query_context_loading_start');
    const [, , defaultSystemPrompt, baseUserContext, systemContext] = await Promise.all([
      // IMPORTANT: do this after setMessages() above, to avoid UI jank
      checkAndDisableBypassPermissionsIfNeeded(toolPermissionContext, setAppState),
      // Gated on TRANSCRIPT_CLASSIFIER so GrowthBook kill switch runs wherever auto mode is built in
      feature('TRANSCRIPT_CLASSIFIER') ? checkAndDisableAutoModeIfNeeded(toolPermissionContext, setAppState, store.getState().fastMode) : undefined, getSystemPrompt(freshTools, mainLoopModelParam, Array.from(toolPermissionContext.additionalWorkingDirectories.keys()), freshMcpClients), getUserContext(), getSystemContext()]);
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(freshMcpClients, isScratchpadEnabled() ? getScratchpadDir() : undefined),
      ...((feature('PROACTIVE') || feature('KAIROS')) && proactiveModule?.isProactiveActive() && !terminalFocusRef.current ? {
        terminalFocus: 'The terminal is unfocused \u2014 the user is not actively watching.'
      } : {})
    };
    queryCheckpoint('query_context_loading_end');
    const systemPrompt = buildEffectiveSystemPrompt({
      mainThreadAgentDefinition,
      toolUseContext,
      customSystemPrompt,
      defaultSystemPrompt,
      appendSystemPrompt
    });
    toolUseContext.renderedSystemPrompt = systemPrompt;
    queryCheckpoint('query_query_start');
    resetTurnHookDuration();
    resetTurnToolDuration();
    resetTurnClassifierDuration();
    for await (const event of query({
      messages: messagesIncludingNewMessages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool,
      toolUseContext,
      querySource: getQuerySourceForREPL()
    })) {
      onQueryEvent(event);
    }
    // Free RSS from large tool_result payloads after each turn.
    // pruneOldToolResults: stubs results outside the rolling window (every turn).
    // applyStableStubs: stubs microcompact-marked blocks (fires at ≥50% context)
    //   while preserving prompt-cache prefix stability.
    // evictOldStubbedMessages: removes fully-stubbed message pairs.
    // evictToMaxSize: caps total display messages to prevent unbounded growth.
    // Applied before onTurnComplete so callers receive the pruned array.
    //
    // The two eviction passes REMOVE messages from the array that seeds the
    // next turn's API view — a prefix mutation behind the cache marker that
    // invalidates the cached prefix. Both are therefore amortized
    // (EVICT_MIN_BATCH batch floor / EVICT_TRIGGER_AT hysteresis band) so
    // the break is paid once per accumulated batch, not once per turn, and
    // the cache-break detector is notified when it happens. The idle-gap
    // sweep in onSubmit handles the free case (cache already expired).
    const before = messagesRef.current as AnyMessage[]
    // Profile-aware: aggressive clips by age (keepTurns=1); retain keeps
    // full results (the display array seeds the next turn's API view) and
    // bounds RSS with the byte-guard instead.
    const cacheProfile = getCacheProfile()
    const stubbed = applyStableStubs(pruneToolResultsByBytes(
      pruneOldToolResults(before, cacheProfile.keepTurns, cacheProfile.stubKeepHeadChars),
      cacheProfile.retainedHighWaterTokens,
      cacheProfile.retainedLowWaterTokens,
      undefined,
      cacheProfile.stubKeepHeadChars,
    ))
    const evicted = evictOldStubbedMessages(stubbed, 2, EVICT_MIN_BATCH)
    const after = evictToMaxSize(evicted, MAX_DISPLAY_MESSAGES, EVICT_TRIGGER_AT)
    if (after !== before) {
      setMessages(() => after as MessageType[])
      if (after !== stubbed && feature('PROMPT_CACHE_BREAK_DETECTION')) {
        // Eviction removed messages from the next request's prefix — an
        // intentional, amortized break. Tell the detector to expect the
        // cache-read drop so it isn't reported as a regression.
        notifyCacheDeletion(getQuerySourceForREPL())
      }
    }
    // Prune orphaned contentReplacementState entries for IDs no longer
    // in the display array. Run unconditionally — orphans can accumulate
    // even when `after === before` (text-only turns, /compact, rewind,
    // resume). pruneContentReplacementState is idempotent and O(N) over
    // the display array plus the state Map, so the cost is microseconds
    // per turn. Without this, seenIds and replacements grow monotonically
    // — evicted messages' preview strings (~2KB each) are never looked up
    // again but never freed.
    pruneContentReplacementState(after, contentReplacementStateRef.current)
    if (isBuddyEnabled()) {
      void fireCompanionObserver(messagesRef.current, reaction => setAppState(prev => prev.companionReaction === reaction ? prev : {
        ...prev,
        companionReaction: reaction
      }));
    }
    queryCheckpoint('query_end');

    resetLoadingState();

    // Log query profiling report if enabled
    logQueryProfileReport();

    // Signal that a query turn has completed successfully
    await onTurnComplete?.(messagesRef.current);
  }, [initialMcpClients, resetLoadingState, getToolUseContext, toolPermissionContext, setAppState, customSystemPrompt, onTurnComplete, appendSystemPrompt, canUseTool, mainThreadAgentDefinition, onQueryEvent, sessionTitle, titleDisabled]);
  const onQuery = useCallback(async (newMessages: MessageType[], abortController: AbortController, shouldQuery: boolean, additionalAllowedTools: string[], mainLoopModelParam: string, onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>, input?: string, effort?: EffortValue): Promise<void> => {
    // If this is a teammate, mark them as active when starting a turn
    if (isAgentSwarmsEnabled()) {
      const teamName = getTeamName();
      const agentName = getAgentName();
      if (teamName && agentName) {
        // Fire and forget - turn starts immediately, write happens in background
        void setMemberActive(teamName, agentName, true);
      }
    }

    // Concurrent guard via state machine. tryStart() atomically checks
    // and transitions idle→running, returning the generation number.
    // Returns null if already running — no separate check-then-set.
    const thisGeneration = queryGuard.tryStart();
    if (thisGeneration === null) {
      logEvent('tengu_concurrent_onquery_detected', {});

      // Extract and enqueue user message text, skipping meta messages
      // (e.g. expanded skill content, tick prompts) that should not be
      // replayed as user-visible text.
      newMessages.filter((m): m is UserMessage => m.type === 'user' && !m.isMeta).map(_ => getContentText(_.message.content)).filter(_ => _ !== null).forEach((msg, i) => {
        enqueue({
          value: msg,
          mode: 'prompt'
        });
        if (i === 0) {
          logEvent('tengu_concurrent_onquery_enqueued', {});
        }
      });
      return;
    }
    try {
      // isLoading is derived from queryGuard — tryStart() above already
      // transitioned dispatching→running, so no setter call needed here.
      // Start the active-wall clock for this turn (frozen while idle so the
      // Session tab's wall duration reflects work time, not process uptime).
      markTurnStart();
      resetTimingRefs();
      // Start-of-turn cache tracker reset. The end-of-turn path at the
      // bottom of this function already resets, but mirror the call here
      // so a turn that never reaches end-of-turn (crash, unhandled
      // rejection, process exit) still starts clean on the next one.
      // Idempotent with respect to the end-of-turn reset — double-reset
      // is a no-op.
      resetCurrentTurn();
      setMessages(oldMessages => [...oldMessages, ...newMessages]);
      responseLengthRef.current = 0;
      if (feature('TOKEN_BUDGET')) {
        const parsedBudget = input ? parseTokenBudget(input) : null;
        snapshotOutputTokensForTurn(parsedBudget ?? getCurrentTurnTokenBudget());
      }
      apiMetricsRef.current = [];
      coalescedStreamingToolUses.cancel();
      setStreamingToolUses([]);
      streamingTextStore.clear();

      // messagesRef is updated synchronously by the setMessages wrapper
      // above, so it already includes newMessages from the append at the
      // top of this try block.  No reconstruction needed, no waiting for
      // React's scheduler (previously cost 20-56ms per prompt; the 56ms
      // case was a GC pause caught during the await).
      const latestMessages = messagesRef.current;
      if (input) {
        await mrOnBeforeQuery(input, latestMessages, newMessages.length);
      }

      // Pass full conversation history to callback
      if (onBeforeQueryCallback && input) {
        const shouldProceed = await onBeforeQueryCallback(input, latestMessages);
        if (!shouldProceed) {
          return;
        }
      }
      await onQueryImpl(latestMessages, newMessages, abortController, shouldQuery, additionalAllowedTools, mainLoopModelParam, effort);
    } finally {
      // queryGuard.end() atomically checks generation and transitions
      // running→idle. Returns false if a newer query owns the guard
      // (cancel+resubmit race where the stale finally fires as a microtask).
      if (queryGuard.end(thisGeneration)) {
        // Fold this turn's active time into the wall accumulator. Skipped when
        // end() returns false (a superseded generation), so a cancel+resubmit
        // stale finally can't double-count.
        markTurnEnd();
        setLastQueryCompletionTime(Date.now());
        skipIdleCheckRef.current = false;
        // Always reset loading state in finally - this ensures cleanup even
        // if onQueryImpl throws. onTurnComplete is called separately in
        // onQueryImpl only on successful completion.
        resetLoadingState();
        await mrOnTurnComplete(messagesRef.current, abortController.signal.aborted);

        // Notify bridge clients that the turn is complete so mobile apps
        // can stop the spark animation and show post-turn UI.
        sendBridgeResultRef.current();

        // Capture budget info before clearing (internal-only)
        let budgetInfo: {
          tokens: number;
          limit: number;
          nudges: number;
        } | undefined;
        if (feature('TOKEN_BUDGET')) {
          if (getCurrentTurnTokenBudget() !== null && getCurrentTurnTokenBudget()! > 0 && !abortController.signal.aborted) {
            budgetInfo = {
              tokens: getTurnOutputTokens(),
              limit: getCurrentTurnTokenBudget()!,
              nudges: getBudgetContinuationCount()
            };
          }
          snapshotOutputTokensForTurn(null);
        }

        // Add turn duration message for turns longer than 30s or with a budget
        // Skip if user aborted or if in loop mode (too noisy between ticks)
        // Defer if swarm teammates are still running (show when they finish)
        const turnDurationMs = Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;
        if ((turnDurationMs > 30000 || budgetInfo !== undefined) && !abortController.signal.aborted && !proactiveActive) {
          const hasRunningSwarmAgents = getAllInProcessTeammateTasks(store.getState().tasks).some(t => t.status === 'running');
          if (hasRunningSwarmAgents) {
            // Only record start time on the first deferred turn
            if (swarmStartTimeRef.current === null) {
              swarmStartTimeRef.current = loadingStartTimeRef.current;
            }
            // Always update budget — later turns may carry the actual budget
            if (budgetInfo) {
              swarmBudgetInfoRef.current = budgetInfo;
            }
          } else {
            setMessages(prev => [...prev, createTurnDurationMessage(turnDurationMs, budgetInfo, count(prev, isLoggableMessage))]);
          }
        }
        // Cache stats line — controlled by `/config showCacheStats`. Shows
        // per-query read/hit stats using the provider-normalized metrics
        // from cacheStatsTracker. 'off' skips, 'compact' gives a one-liner,
        // 'full' gives a breakdown. Display is skipped when the user
        // aborted or proactive mode is active — but the counter reset
        // below still runs in those cases.
        if (!abortController.signal.aborted && !proactiveActive) {
          // Defensive default: config layer already merges 'compact' from
          // DEFAULT_GLOBAL_CONFIG (see config.ts:1494) for configs that
          // predate this feature, so `mode` should always be defined.
          // The `?? 'compact'` fallback covers pathological cases — a
          // corrupt config read that returned an empty object, or a
          // race between writer and reader — where the merge didn't
          // land. Rendering the line is the safer failure mode than
          // silently hiding it.
          const mode = getGlobalConfig().showCacheStats ?? 'compact';
          if (mode !== 'off') {
            const turnMetrics = getCurrentTurnCacheMetrics();
            // Skip rendering if the turn recorded no API activity at all —
            // avoids a spurious "[Cache: cold]" on local-only commands.
            if (turnMetrics.supported || turnMetrics.read > 0 || turnMetrics.total > 0) {
              const line = mode === 'full' ? formatCacheMetricsFull(turnMetrics) : formatCacheMetricsCompact(turnMetrics);
              setMessages(prev => [...prev, createSystemMessage(line, 'info')]);
            }
          }
        }
        // Reset turn counters UNCONDITIONALLY — users routinely interrupt
        // (Ctrl+C) mid-turn, and if we kept the reset gated on
        // !aborted, the in-flight turn's metrics would leak into the
        // next turn's aggregate. Proactive turns also need the reset so
        // their metrics don't pile onto the following user turn.
        resetCurrentTurn();
        // Clear the controller so CancelRequestHandler's canCancelRunningTask
        // reads false at the idle prompt. Without this, the stale non-aborted
        // controller makes ctrl+c fire onCancel() (aborting nothing) instead of
        // propagating to the double-press exit flow.
        setAbortController(null);
      }

      // Auto-restore: if the user interrupted before any meaningful response
      // arrived, rewind the conversation and restore their prompt — same as
      // opening the message selector and picking the last message.
      // This runs OUTSIDE the queryGuard.end() check because onCancel calls
      // forceEnd(), which bumps the generation so end() returns false above.
      // Guards: reason === 'user-cancel' (onCancel/Esc; programmatic aborts
      // use 'background'/'interrupt' and must not rewind — note abort() with
      // no args sets reason to a DOMException, not undefined), !isActive (no
      // newer query started — cancel+resubmit race), empty input (don't
      // clobber text typed during loading), no queued commands (user queued
      // B while A was loading → they've moved on, don't restore A; also
      // avoids removeLastFromHistory removing B's entry instead of A's),
      // not viewing a teammate (messagesRef is the main conversation — the
      // old Up-arrow quick-restore had this guard, preserve it).
      if (abortController.signal.reason === 'user-cancel' && !queryGuard.isActive && inputValueRef.current === '' && getCommandQueueLength() === 0 && !store.getState().viewingAgentTaskId) {
        const msgs = messagesRef.current;
        const lastUserMsg = msgs.findLast(selectableUserMessagesFilter);
        if (lastUserMsg) {
          const idx = msgs.lastIndexOf(lastUserMsg);
          if (messagesAfterAreOnlySynthetic(msgs, idx)) {
            // The submit is being undone — undo its history entry too,
            // otherwise Up-arrow shows the restored text twice.
            removeLastFromHistory();
            restoreMessageSyncRef.current(lastUserMsg);
          }
        }
      }
    }
  }, [onQueryImpl, setAppState, resetLoadingState, queryGuard, mrOnBeforeQuery, mrOnTurnComplete]);

  return { onQuery };
}
