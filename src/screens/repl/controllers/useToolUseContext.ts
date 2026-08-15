// Owns the tool-use context plumbing: `setToolPermissionContext` (+ the swarm
// leader registration effect), `canUseTool`, `requestPrompt`,
// `getToolUseContext` (the per-turn ProcessUserInputContext factory) and
// `handleBackgroundQuery` (Ctrl+B session backgrounding).
//
// Extracted from src/screens/REPL.tsx (controllers, ROADMAP 11e deferred half).
// Before extraction these five declarations plus one effect sat consecutively
// between the sandbox-unavailable block and `useSessionBackgrounding(...)`, in
// exactly the order reproduced below. Nothing else sat between them.
//
// IMPORTANT - hook order: REPL.tsx invokes `useToolUseContext(...)` at exactly
// the position `setToolPermissionContext` occupied, and this file calls the same
// hooks in the same order - useCallback, useEffect, useCanUseTool, useCallback,
// useCallback, useCallback - with verbatim dependency arrays. `useCanUseTool` is
// itself a hook, so its position between the effect and `requestPrompt` is
// load-bearing and must not be moved.
//
// `getToolUseContext` deliberately reads mutable values FRESH from
// `store.getState()` rather than closing over `useAppState()` snapshots: the MCP
// connection manager populates `appState.mcp` asynchronously, so the store can
// hold newer state than the render that captured this closure. `computeTools` is
// handed back as `refreshTools` for the same reason - mid-query tool-list
// updates re-run it.

import { useCallback, useEffect } from 'react';
import { feature } from 'bun:bundle';
import { sendNotification } from 'src/platform/notifications/notifier.js';
import { registerLeaderSetToolPermissionContext, unregisterLeaderSetToolPermissionContext } from 'src/coordinator/swarm/leaderPermissionBridge.js';
import { type ResumeEntrypoint } from 'src/commands.js';
import { type ToolUseConfirm } from 'src/components/permissions/PermissionRequest.js';
import type { PromptRequest, PromptResponse } from 'src/types/hooks.js';
import { getSystemPrompt } from 'src/constants/prompts.js';
import { buildEffectiveSystemPrompt } from 'src/utils/systemPrompt.js';
import { getSystemContext, getUserContext } from 'src/context.js';
import useCanUseTool from 'src/hooks/useCanUseTool.js';
import type { ToolPermissionContext, Tool } from 'src/Tool.js';
import type { ThinkingConfig } from 'src/services/context/thinking.js';
import type { Message as MessageType } from 'src/types/message.js';
import { mergeClients } from 'src/hooks/useMergedClients.js';
import { getQuerySourceForREPL } from 'src/utils/promptCategory.js';
import { mergeAndFilterTools } from 'src/services/tools/toolPool.js';
import type { ScopedMcpServerConfig } from 'src/services/mcp/types.js';
import { type IDESelection } from 'src/platform/ide/useIdeSelection.js';
import { assembleToolPool } from 'src/tools.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { resolveAgentTools } from 'src/tools/AgentTool/agentToolUtils.js';
import type { ProcessUserInputContext } from 'src/services/input/processUserInput.js';
import type { LogOption } from 'src/types/logs.js';
import { type FileHistoryState } from 'src/shared/fs/fileHistory.js';
import { type AttributionState } from 'src/services/git/commitAttribution.js';
import { type IDEExtensionInstallationStatus, type IdeType } from 'src/platform/ide/ide.js';
import { type SetAppState, removeByFilter } from 'src/utils/messageQueueManager.js';
import { startBackgroundSession } from 'src/tasks/LocalMainSessionTask.js';
import type { Theme } from 'src/terminal/theme/theme.js';
import { createAttachmentMessage, getQueuedCommandAttachments } from 'src/services/attachments/attachments.js';

export interface UseToolUseContextDeps {
  // --- static-ish session inputs
  commands: ProcessUserInputContext['options']['commands'];
  debug: boolean;
  disabled: boolean;
  combinedInitialTools: Tool[];
  initialMcpClients: ProcessUserInputContext['options']['mcpClients'] | undefined;
  mainThreadAgentDefinition: AgentDefinition | undefined;
  allowedAgentTypes: string[] | undefined;
  customSystemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  thinkingConfig: ThinkingConfig;
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined;
  ideInstallationStatus: IDEExtensionInstallationStatus | null;
  // `useTheme()` yields the theme NAME, not the palette. The palette type
  // (`Theme`) is only used for the `keyof Theme` spinner colours below.
  theme: ProcessUserInputContext['options']['theme'];
  terminal: ReturnType<typeof import('src/terminal/ink/useTerminalNotification.js').useTerminalNotification>;
  terminalTitle: string;
  mainLoopModel: string;
  toolPermissionContext: ToolPermissionContext;
  abortController: AbortController | null;
  store: ReturnType<typeof import('src/terminal/state/AppState.js').useAppStateStore>;
  // --- refs
  messagesRef: React.RefObject<MessageType[]>;
  readFileState: React.RefObject<ReturnType<typeof import('src/shared/fs/fileStateCache.js').createFileStateCacheWithSizeLimit>>;
  discoveredSkillNamesRef: React.RefObject<Set<string>>;
  loadedNestedMemoryPathsRef: React.RefObject<Set<string>>;
  contentReplacementStateRef: { current: ReturnType<typeof import('src/services/tools/toolResultStorage.js').provisionContentReplacementState> };
  hasInterruptibleToolInProgressRef: React.RefObject<boolean>;
  // --- callbacks handed through into the context
  resume: (sessionId: `${string}-${string}-${string}-${string}-${string}`, log: LogOption, entrypoint: ResumeEntrypoint) => Promise<void>;
  reverify: () => void;
  onChangeDynamicMcpConfig: (config: Record<string, ScopedMcpServerConfig>) => void;
  syncToolResultReplacements: (replacements: ReadonlyMap<string, string>) => void;
  addNotification: ReturnType<typeof import('src/terminal/contexts/notifications.js').useNotifications>['addNotification'];
  setToolJSX: (args: {
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand?: boolean;
    isImmediate?: boolean;
    clearLocalJSX?: boolean;
    generation?: number;
  } | null) => void;
  // --- setters
  setAppState: SetAppState;
  setMessages: (action: React.SetStateAction<MessageType[]>) => void;
  setConversationId: React.Dispatch<React.SetStateAction<`${string}-${string}-${string}-${string}-${string}`>>;
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>;
  setPromptQueue: React.Dispatch<React.SetStateAction<Array<{
    request: PromptRequest;
    title: string;
    toolInputSummary?: string | null;
    resolve: (response: PromptResponse) => void;
    reject: (error: Error) => void;
  }>>>;
  setIsMessageSelectorVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setIDEToInstallExtension: React.Dispatch<React.SetStateAction<IdeType | null>>;
  setInProgressToolUseIDs: React.Dispatch<React.SetStateAction<Set<string>>>;
  setResponseLength: (f: (prev: number) => number) => void;
  setStreamMode: React.Dispatch<React.SetStateAction<import('src/terminal/spinner/Spinner.js').SpinnerMode>>;
  setSpinnerColor: React.Dispatch<React.SetStateAction<keyof Theme | null>>;
  setSpinnerShimmerColor: React.Dispatch<React.SetStateAction<keyof Theme | null>>;
  setSpinnerMessage: React.Dispatch<React.SetStateAction<string | null>>;
}

export function useToolUseContext(deps: UseToolUseContextDeps) {
  const {
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
  } = deps;

  const setToolPermissionContext = useCallback((context: ToolPermissionContext, options?: {
    preserveMode?: boolean;
  }) => {
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...context,
        // Preserve the coordinator's mode only when explicitly requested.
        // Workers' getAppState() returns a transformed context with mode
        // 'acceptEdits' that must not leak into the coordinator's actual
        // state via permission-rule updates — those call sites pass
        // { preserveMode: true }. User-initiated mode changes (e.g.,
        // selecting "allow all edits") must NOT be overridden.
        mode: options?.preserveMode ? prev.toolPermissionContext.mode : context.mode
      }
    }));

    // When permission context changes, recheck all queued items
    // This handles the case where approving item1 with "don't ask again"
    // should auto-approve other queued items that now match the updated rules
    setImmediate(setToolUseConfirmQueue => {
      // Use setToolUseConfirmQueue callback to get current queue state
      // instead of capturing it in the closure, to avoid stale closure issues
      setToolUseConfirmQueue(currentQueue => {
        currentQueue.forEach(item => {
          void item.recheckPermission();
        });
        return currentQueue;
      });
    }, setToolUseConfirmQueue);
  }, [setAppState, setToolUseConfirmQueue]);

  // Register the leader's setToolPermissionContext for in-process teammates
  useEffect(() => {
    registerLeaderSetToolPermissionContext(setToolPermissionContext);
    return () => unregisterLeaderSetToolPermissionContext();
  }, [setToolPermissionContext]);
  const canUseTool = useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext);
  const requestPrompt = useCallback((title: string, toolInputSummary?: string | null) => (request: PromptRequest): Promise<PromptResponse> => new Promise<PromptResponse>((resolve, reject) => {
    setPromptQueue(prev => [...prev, {
      request,
      title,
      toolInputSummary,
      resolve,
      reject
    }]);
  }), []);
  const getToolUseContext = useCallback((messages: MessageType[], newMessages: MessageType[], abortController: AbortController, mainLoopModel: string): ProcessUserInputContext => {
    // Read mutable values fresh from the store rather than closure-capturing
    // useAppState() snapshots. Same values today (closure is refreshed by the
    // render between turns); decouples freshness from React's render cycle for
    // a future headless conversation loop. Same pattern refreshTools() uses.
    const s = store.getState();

    // Compute tools fresh from store.getState() rather than the closure-
    // captured `tools`. useManageMCPConnections populates appState.mcp
    // async as servers connect — the store may have newer MCP state than
    // the closure captured at render time. Also doubles as refreshTools()
    // for mid-query tool list updates.
    const computeTools = () => {
      const state = store.getState();
      const assembled = assembleToolPool(state.toolPermissionContext, state.mcp.tools);
      const merged = mergeAndFilterTools(combinedInitialTools, assembled, state.toolPermissionContext.mode);
      if (!mainThreadAgentDefinition) return merged;
      return resolveAgentTools(mainThreadAgentDefinition, merged, false, true).resolvedTools;
    };
    return {
      abortController,
      options: {
        commands,
        tools: computeTools(),
        debug,
        verbose: s.verbose,
        mainLoopModel,
        thinkingConfig: s.thinkingEnabled !== false ? thinkingConfig : {
          type: 'disabled'
        },
        // Merge fresh from store rather than closing over useMergedClients'
        // memoized output. initialMcpClients is a prop (session-constant).
        mcpClients: mergeClients(initialMcpClients, s.mcp.clients),
        mcpResources: s.mcp.resources,
        ideInstallationStatus: ideInstallationStatus,
        isNonInteractiveSession: false,
        dynamicMcpConfig,
        theme,
        agentDefinitions: allowedAgentTypes ? {
          ...s.agentDefinitions,
          allowedAgentTypes
        } : s.agentDefinitions,
        customSystemPrompt,
        appendSystemPrompt,
        refreshTools: computeTools
      },
      getAppState: () => store.getState(),
      setAppState,
      messages,
      setMessages,
      updateFileHistoryState(updater: (prev: FileHistoryState) => FileHistoryState) {
        // Perf: skip the setState when the updater returns the same reference
        // (e.g. fileHistoryTrackEdit returns `state` when the file is already
        // tracked). Otherwise every no-op call would notify all store listeners.
        setAppState(prev => {
          const updated = updater(prev.fileHistory);
          if (updated === prev.fileHistory) return prev;
          return {
            ...prev,
            fileHistory: updated
          };
        });
      },
      updateAttributionState(updater: (prev: AttributionState) => AttributionState) {
        setAppState(prev => {
          const updated = updater(prev.attribution);
          if (updated === prev.attribution) return prev;
          return {
            ...prev,
            attribution: updated
          };
        });
      },
      openMessageSelector: () => {
        if (!disabled) {
          setIsMessageSelectorVisible(true);
        }
      },
      onChangeAPIKey: reverify,
      readFileState: readFileState.current,
      setToolJSX,
      addNotification,
      appendSystemMessage: msg => setMessages(prev => [...prev, msg]),
      sendOSNotification: opts => {
        void sendNotification(opts, terminal);
      },
      onChangeDynamicMcpConfig,
      onInstallIDEExtension: setIDEToInstallExtension,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: discoveredSkillNamesRef.current,
      setResponseLength,
      pushApiMetricsEntry: undefined,
      setStreamMode,
      onCompactProgress: event => {
        switch (event.type) {
          case 'hooks_start':
            setSpinnerColor('claudeBlue_FOR_SYSTEM_SPINNER');
            setSpinnerShimmerColor('claudeBlueShimmer_FOR_SYSTEM_SPINNER');
            setSpinnerMessage(event.hookType === 'pre_compact' ? 'Running PreCompact hooks\u2026' : event.hookType === 'post_compact' ? 'Running PostCompact hooks\u2026' : 'Running SessionStart hooks\u2026');
            break;
          case 'compact_start':
            setSpinnerMessage('Compacting conversation');
            break;
          case 'compact_end':
            setSpinnerMessage(null);
            setSpinnerColor(null);
            setSpinnerShimmerColor(null);
            break;
        }
      },
      setInProgressToolUseIDs,
      setHasInterruptibleToolInProgress: (v: boolean) => {
        hasInterruptibleToolInProgressRef.current = v;
      },
      resume,
      setConversationId,
      requestPrompt: feature('HOOK_PROMPTS') ? requestPrompt : undefined,
      contentReplacementState: contentReplacementStateRef.current,
      syncToolResultReplacements
    };
  }, [commands, combinedInitialTools, mainThreadAgentDefinition, debug, initialMcpClients, ideInstallationStatus, dynamicMcpConfig, theme, allowedAgentTypes, store, setAppState, reverify, addNotification, setMessages, onChangeDynamicMcpConfig, resume, requestPrompt, disabled, customSystemPrompt, appendSystemPrompt, setConversationId, syncToolResultReplacements]);

  // Session backgrounding (Ctrl+B to background/foreground)
  const handleBackgroundQuery = useCallback(() => {
    // Stop the foreground query so the background one takes over
    abortController?.abort('background');
    // Aborting subagents may produce task-completed notifications.
    // Clear task notifications so the queue processor doesn't immediately
    // start a new foreground query; forward them to the background session.
    const removedNotifications = removeByFilter(cmd => cmd.mode === 'task-notification');
    void (async () => {
      const toolUseContext = getToolUseContext(messagesRef.current, [], new AbortController(), mainLoopModel);
      const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([getSystemPrompt(toolUseContext.options.tools, mainLoopModel, Array.from(toolPermissionContext.additionalWorkingDirectories.keys()), toolUseContext.options.mcpClients), getUserContext(), getSystemContext()]);
      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt
      });
      toolUseContext.renderedSystemPrompt = systemPrompt;
      const notificationAttachments = await getQueuedCommandAttachments(removedNotifications).catch(() => []);
      const notificationMessages = notificationAttachments.map(createAttachmentMessage);

      // Deduplicate: if the query loop already yielded a notification into
      // messagesRef before we removed it from the queue, skip duplicates.
      // We use prompt text for dedup because source_uuid is not set on
      // task-notification QueuedCommands (enqueuePendingNotification callers
      // don't pass uuid), so it would always be undefined.
      const existingPrompts = new Set<string>();
      for (const m of messagesRef.current) {
        if (m.type === 'attachment' && m.attachment.type === 'queued_command' && m.attachment.commandMode === 'task-notification' && typeof m.attachment.prompt === 'string') {
          existingPrompts.add(m.attachment.prompt);
        }
      }
      const uniqueNotifications = notificationMessages.filter(m => m.attachment.type === 'queued_command' && (typeof m.attachment.prompt !== 'string' || !existingPrompts.has(m.attachment.prompt)));
      startBackgroundSession({
        messages: [...messagesRef.current, ...uniqueNotifications],
        queryParams: {
          systemPrompt,
          userContext,
          systemContext,
          canUseTool,
          toolUseContext,
          querySource: getQuerySourceForREPL()
        },
        description: terminalTitle,
        setAppState,
        agentDefinition: mainThreadAgentDefinition
      });
    })();
  }, [abortController, mainLoopModel, toolPermissionContext, mainThreadAgentDefinition, getToolUseContext, customSystemPrompt, appendSystemPrompt, canUseTool, setAppState]);

  return {
    setToolPermissionContext,
    canUseTool,
    getToolUseContext,
    handleBackgroundQuery,
  };
}
