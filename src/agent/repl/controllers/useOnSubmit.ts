// Owns `onSubmit` — the prompt-submission controller: immediate slash commands,
// idle-return gating, history, stash restore, speculation accept, the remote
// path, the idle-gap eviction sweep, and the handoff to handlePromptSubmit.
//
// Extracted from src/agent/repl/REPL.tsx (controllers, ROADMAP 11e deferred half).
// Before extraction this was one `useCallback` sitting between the
// initial-message effect and `onAgentSubmit`.
//
// IMPORTANT - hook order: REPL.tsx invokes `useOnSubmit(...)` at exactly the
// position the original `useCallback` occupied, and this file performs exactly
// one hook call (that same `useCallback`). The component's hook-call sequence
// is unchanged.
//
// The dependency array at the bottom is verbatim, including its two load-bearing
// oddities - do not "clean" either:
//   * `messages` is deliberately ABSENT. It is read through `messagesRef.current`
//     so onSubmit stays stable across message updates; adding it back recreates
//     onSubmit ~30x per turn and pins the REPL render scope (1776B) plus that
//     render's messages array in downstream closures (PromptInput,
//     handleAutoRunIssue). Heap analysis after #20174/#20175 found ~9 REPL scopes
//     and ~15 messages array versions accumulating, all traced to that dep.
//   * `remoteSession` is listed but never read in the body. It is there so the
//     callback is recreated when the remote session object changes; `activeRemote`
//     is derived from it and is not itself a dep.

import { useCallback } from 'react';
import { feature } from 'bun:bundle';
import { getTotalInputTokens, getOriginalCwd } from 'src/platform/bootstrap/state.js';
import { logForDebugging } from 'src/shared/debug.js';
import { type Command, type CommandResultDisplay, getCommandName, isCommandEnabled } from 'src/commands.js';
import type { PromptInputMode } from 'src/types/textInputTypes.js';
import { addToHistory, expandPastedTextRefs, parseReferences } from 'src/agent/history.js';
import { prependModeCharacterToInput } from 'src/terminal/prompt-input/inputModes.js';
import { prependToShellHistoryCache } from 'src/terminal/suggestions/shellHistoryCompletion.js';
import { getGlobalConfig, type PastedContent } from 'src/platform/config/config.js';
import { logEvent, type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/platform/analytics/index.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js';
import { createUserMessage, createCommandInputMessage, formatCommandInputTags } from 'src/agent/messages/messages.js';
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/constants/xml.js';
import { escapeXml } from 'src/shared/data/xml.js';
import { handlePromptSubmit, type PromptInputHelpers } from 'src/agent/handlePromptSubmit.js';
import type { Message as MessageType } from 'src/types/message.js';
import { getQuerySourceForREPL } from 'src/agent/promptCategory.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import { evaluateTimeBasedTrigger } from 'src/agent/compact/microCompact.js';
import { evictOldStubbedMessages, evictToMaxSize, MAX_DISPLAY_MESSAGES, type AnyMessage } from 'src/agent/compact/stableStubState.js';
import { incrementPromptCount } from 'src/vcs/git/commitAttribution.js';
import { recordAttributionSnapshot } from 'src/services/session/sessionStorage.js';
import { type SetAppState } from 'src/agent/messageQueueManager.js';
import { getCurrentLocalJSXGeneration } from 'src/terminal/toolJSXStore.js';
import { handleSpeculationAccept, type ActiveSpeculationState } from 'src/terminal/prompt-suggestion/speculation.js';
import { createAbortController } from 'src/shared/abortController.js';
import type { RemoteMessageContent } from 'src/platform/teleport/api.js';
import { isFullscreenEnvEnabled } from 'src/terminal/render/fullscreen.js';
import type { QueryGuard } from 'src/agent/QueryGuard.js';
import type { IDESelection } from 'src/platform/ide/useIdeSelection.js';
import type { SpinnerMode } from 'src/terminal/spinner/Spinner.js';
import type { ProcessUserInputContext } from 'src/agent/input/processUserInput.js';
import type { EffortValue } from 'src/utils/effort.js';
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js';
import type { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js';
import type { useRemoteSession } from 'src/hooks/useRemoteSession.js';
import type { useDirectConnect } from 'src/providers/hooks/useDirectConnect.js';
import type { useSSHSession } from 'src/hooks/useSSHSession.js';
import type { useNotifications } from 'src/terminal/contexts/notifications.js';
import type { useDeferredHookMessages } from 'src/agent/hooks/useDeferredHookMessages.js';

// Mirrors the module-level binding in REPL.tsx. `feature()` must sit DIRECTLY in
// a ternary condition - the build folds it in place and any other form throws.
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../../../platform/proactive/index.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */

export type ActiveRemote =
  | ReturnType<typeof useSSHSession>
  | ReturnType<typeof useDirectConnect>
  | ReturnType<typeof useRemoteSession>;

export interface StashedPrompt {
  text: string;
  cursorOffset: number;
  pastedContents: Record<number, PastedContent>;
}

export interface UseOnSubmitDeps {
  // --- query plumbing
  onQuery: (
    newMessages: MessageType[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModelParam: string,
    onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>,
    input?: string,
    effort?: EffortValue,
  ) => Promise<void>;
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext;
  canUseTool: CanUseToolFn;
  onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>;
  queryGuard: QueryGuard;
  awaitPendingHooks: ReturnType<typeof useDeferredHookMessages>;
  // --- session / model
  commands: Command[];
  mainLoopModel: string;
  ideSelection: IDESelection | undefined;
  isLoading: boolean;
  isExternalLoading: boolean;
  abortController: AbortController | null;
  activeRemote: ActiveRemote;
  remoteSession: ReturnType<typeof useRemoteSession>;
  // --- input state
  inputMode: PromptInputMode;
  pastedContents: Record<number, PastedContent>;
  stashedPrompt: StashedPrompt | undefined;
  // --- refs (stable; intentionally absent from the dep array)
  messagesRef: React.RefObject<MessageType[]>;
  inputValueRef: React.RefObject<string>;
  readFileState: React.RefObject<ReturnType<typeof createFileStateCacheWithSizeLimit>>;
  streamModeRef: React.RefObject<SpinnerMode>;
  idleHintShownRef: React.RefObject<string | false>;
  lastQueryCompletionTimeRef: React.RefObject<number>;
  skipIdleCheckRef: React.RefObject<boolean>;
  tipPickedThisTurnRef: React.RefObject<boolean>;
  hasInterruptibleToolInProgressRef: React.RefObject<boolean>;
  // --- setters
  setMessages: (action: React.SetStateAction<MessageType[]>) => void;
  setAppState: SetAppState;
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>;
  setInputValue: (value: string) => void;
  setInputMode: React.Dispatch<React.SetStateAction<PromptInputMode>>;
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>;
  setStashedPrompt: React.Dispatch<React.SetStateAction<StashedPrompt | undefined>>;
  setSubmitCount: React.Dispatch<React.SetStateAction<number>>;
  setIDESelection: React.Dispatch<React.SetStateAction<IDESelection | undefined>>;
  setIdleReturnPending: React.Dispatch<React.SetStateAction<{ input: string; idleMinutes: number } | null>>;
  setUserInputOnProcessing: (input: string | undefined) => void;
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
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  repinScroll: () => void;
  resetTimingRefs: () => void;
}

export type OnSubmit = (
  input: string,
  helpers: PromptInputHelpers,
  speculationAccept?: {
    state: ActiveSpeculationState;
    speculationSessionTimeSavedMs: number;
    setAppState: SetAppState;
  },
  options?: { fromKeybinding?: boolean },
) => Promise<void>;

export function useOnSubmit(deps: UseOnSubmitDeps): OnSubmit {
  const {
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
  } = deps;

  const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers, speculationAccept?: {
    state: ActiveSpeculationState;
    speculationSessionTimeSavedMs: number;
    setAppState: SetAppState;
  }, options?: {
    fromKeybinding?: boolean;
  }) => {
    // Re-pin scroll to bottom on submit so the user always sees the new
    // exchange (matches OpenCode's auto-scroll behavior).
    repinScroll();

    // Resume loop mode if paused
    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.resumeProactive();
    }

    // Handle immediate commands - these bypass the queue and execute right away
    // even while Claude is processing. Commands opt-in via `immediate: true`.
    // Commands triggered via keybindings are always treated as immediate.
    if (!speculationAccept && input.trim().startsWith('/')) {
      // Expand [Pasted text #N] refs so immediate commands (e.g. /btw) receive
      // the pasted content, not the placeholder. The non-immediate path gets
      // this expansion later in handlePromptSubmit.
      const trimmedInput = expandPastedTextRefs(input, pastedContents).trim();
      const spaceIndex = trimmedInput.indexOf(' ');
      const commandName = spaceIndex === -1 ? trimmedInput.slice(1) : trimmedInput.slice(1, spaceIndex);
      const commandArgs = spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim();

      // Find matching command - treat as immediate if:
      // 1. Command has `immediate: true`, OR
      // 2. Command was triggered via keybinding (fromKeybinding option)
      const matchingCommand = commands.find(cmd => isCommandEnabled(cmd) && (cmd.name === commandName || cmd.aliases?.includes(commandName) || getCommandName(cmd) === commandName));
      if (matchingCommand?.name === 'new' && idleHintShownRef.current) {
        logEvent('tengu_idle_return_action', {
          action: 'hint_converted' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          variant: idleHintShownRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          idleMinutes: Math.round((Date.now() - lastQueryCompletionTimeRef.current) / 60_000),
          messageCount: messagesRef.current.length,
          totalInputTokens: getTotalInputTokens()
        });
        idleHintShownRef.current = false;
      }
      const shouldTreatAsImmediate = queryGuard.isActive && (matchingCommand?.immediate || options?.fromKeybinding);
      if (matchingCommand && shouldTreatAsImmediate && matchingCommand.type === 'local-jsx') {
        // Only clear input if the submitted text matches what's in the prompt.
        // When a command keybinding fires, input is "/<command>" but the actual
        // input value is the user's existing text - don't clear it in that case.
        if (input.trim() === inputValueRef.current.trim()) {
          setInputValue('');
          helpers.setCursorOffset(0);
          helpers.clearBuffer();
          setPastedContents({});
        }
        const pastedTextRefs = parseReferences(input).filter(r => pastedContents[r.id]?.type === 'text');
        const pastedTextCount = pastedTextRefs.length;
        const pastedTextBytes = pastedTextRefs.reduce((sum, r) => sum + (pastedContents[r.id]?.content.length ?? 0), 0);
        logEvent('tengu_paste_text', {
          pastedTextCount,
          pastedTextBytes
        });
        logEvent('tengu_immediate_command_executed', {
          commandName: matchingCommand.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fromKeybinding: options?.fromKeybinding ?? false
        });

        // Execute the command directly
        const executeImmediateCommand = async (): Promise<void> => {
          let doneWasCalled = false;
          const onDone = (result?: string, doneOptions?: {
            display?: CommandResultDisplay;
            metaMessages?: string[];
          }): void => {
            doneWasCalled = true;
            setToolJSX({
              jsx: null,
              shouldHidePromptInput: false,
              clearLocalJSX: true
            });
            const newMessages: MessageType[] = [];
            if (result && doneOptions?.display !== 'skip') {
              addNotification({
                key: `immediate-${matchingCommand.name}`,
                text: result,
                priority: 'immediate'
              });
              // In fullscreen the command just showed as a centered modal
              // pane — the notification above is enough feedback. Adding
              // "❯ /config" + "⎿ dismissed" to the transcript is clutter
              // (those messages are type:system subtype:local_command —
              // user-visible but NOT sent to the model, so skipping them
              // doesn't change model context). Outside fullscreen the
              // transcript entry stays so scrollback shows what ran.
              if (!isFullscreenEnvEnabled()) {
                newMessages.push(createCommandInputMessage(formatCommandInputTags(getCommandName(matchingCommand), commandArgs)), createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(result)}</${LOCAL_COMMAND_STDOUT_TAG}>`));
              }
            }
            // Inject meta messages (model-visible, user-hidden) into the transcript
            if (doneOptions?.metaMessages?.length) {
              newMessages.push(...doneOptions.metaMessages.map(content => createUserMessage({
                content,
                isMeta: true
              })));
            }
            if (newMessages.length) {
              setMessages(prev => [...prev, ...newMessages]);
            }
            // Restore stashed prompt after local-jsx command completes.
            // The normal stash restoration path (below) is skipped because
            // local-jsx commands return early from onSubmit.
            if (stashedPrompt !== undefined) {
              setInputValue(stashedPrompt.text);
              helpers.setCursorOffset(stashedPrompt.cursorOffset);
              setPastedContents(stashedPrompt.pastedContents);
              setStashedPrompt(undefined);
            }
          };

          // Build context for the command (reuses existing getToolUseContext).
          // Read messages via ref to keep onSubmit stable across message
          // updates — matches the pattern at L2384/L2400/L2662 and avoids
          // pinning stale REPL render scopes in downstream closures.
          const context = getToolUseContext(messagesRef.current, [], createAbortController(), mainLoopModel);
          // Capture the generation token BEFORE any await — see toolJSXStore.ts.
          const generation = getCurrentLocalJSXGeneration();
          const mod = await matchingCommand.load();
          const jsx = await mod.call(onDone, context, commandArgs);

          // doneWasCalled guards sync onDone; generation guards the async race.
          if (jsx && !doneWasCalled) {
            // shouldHidePromptInput: false keeps Notifications mounted
            // so the onDone result isn't lost
            setToolJSX({
              jsx,
              shouldHidePromptInput: false,
              isLocalJSXCommand: true,
              generation
            });
          }
        };
        void executeImmediateCommand();
        return; // Always return early - don't add to history or queue
      }
    }

    // Remote mode: skip empty input early before any state mutations
    if (activeRemote.isRemoteMode && !input.trim()) {
      return;
    }

    // Idle-return: prompt returning users to start fresh when the
    // conversation is large and the cache is cold. tengu_willow_mode
    // controls treatment: "dialog" (blocking), "hint" (notification), "off".
    {
      const willowMode = getFeatureValue_CACHED_MAY_BE_STALE('tengu_willow_mode', 'off');
      const idleThresholdMin = Number(process.env.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES ?? 75);
      const tokenThreshold = Number(process.env.CLAUDE_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000);
      if (willowMode !== 'off' && !getGlobalConfig().idleReturnDismissed && !skipIdleCheckRef.current && !speculationAccept && !input.trim().startsWith('/') && lastQueryCompletionTimeRef.current > 0 && getTotalInputTokens() >= tokenThreshold) {
        const idleMs = Date.now() - lastQueryCompletionTimeRef.current;
        const idleMinutes = idleMs / 60_000;
        if (idleMinutes >= idleThresholdMin && willowMode === 'dialog') {
          setIdleReturnPending({
            input,
            idleMinutes
          });
          setInputValue('');
          helpers.setCursorOffset(0);
          helpers.clearBuffer();
          return;
        }
      }
    }

    // Add to history for direct user submissions.
    // Queued command processing (executeQueuedInput) doesn't call onSubmit,
    // so notifications and already-queued user input won't be added to history here.
    // Skip history for keybinding-triggered commands (user didn't type the command).
    if (!options?.fromKeybinding) {
      addToHistory({
        display: speculationAccept ? input : prependModeCharacterToInput(input, inputMode),
        pastedContents: speculationAccept ? {} : pastedContents
      });
      // Add the just-submitted command to the front of the ghost-text
      // cache so it's suggested immediately (not after the 60s TTL).
      if (inputMode === 'bash') {
        prependToShellHistoryCache(input.trim());
      }
    }

    // Restore stash if present, but NOT for slash commands or when loading.
    // - Slash commands (especially interactive ones like /model, /context) hide
    //   the prompt and show a picker UI. Restoring the stash during a command would
    //   place the text in a hidden input, and the user would lose it by typing the
    //   next command. Instead, preserve the stash so it survives across command runs.
    // - When loading, the submitted input will be queued and handlePromptSubmit
    //   will clear the input field (onInputChange('')), which would clobber the
    //   restored stash. Defer restoration to after handlePromptSubmit (below).
    //   Remote mode is exempt: it sends via WebSocket and returns early without
    //   calling handlePromptSubmit, so there's no clobbering risk — restore eagerly.
    // In both deferred cases, the stash is restored after await handlePromptSubmit.
    const isSlashCommand = !speculationAccept && input.trim().startsWith('/');
    // Submit runs "now" (not queued) when not already loading, or when
    // accepting speculation, or in remote mode (which sends via WS and
    // returns early without calling handlePromptSubmit).
    const submitsNow = !isLoading || speculationAccept || activeRemote.isRemoteMode;
    if (stashedPrompt !== undefined && !isSlashCommand && submitsNow) {
      setInputValue(stashedPrompt.text);
      helpers.setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    } else if (submitsNow) {
      if (!options?.fromKeybinding) {
        // Clear input when not loading or accepting speculation.
        // Preserve input for keybinding-triggered commands.
        setInputValue('');
        helpers.setCursorOffset(0);
      }
      setPastedContents({});
    }
    if (submitsNow) {
      setInputMode('prompt');
      setIDESelection(undefined);
      setSubmitCount(_ => _ + 1);
      helpers.clearBuffer();
      tipPickedThisTurnRef.current = false;

      // Show the placeholder in the same React batch as setInputValue('').
      // Skip for slash/bash (they have their own echo), speculation and remote
      // mode (both setMessages directly with no gap to bridge).
      if (!isSlashCommand && inputMode === 'prompt' && !speculationAccept && !activeRemote.isRemoteMode) {
        setUserInputOnProcessing(input);
        // showSpinner includes userInputOnProcessing, so the spinner appears
        // on this render. Reset timing refs now (before queryGuard.reserve()
        // would) so elapsed time doesn't read as Date.now() - 0. The
        // isQueryActive transition above does the same reset — idempotent.
        resetTimingRefs();
      }

      // Increment prompt count for attribution tracking and save snapshot
      // The snapshot persists promptCount so it survives compaction
      if (feature('COMMIT_ATTRIBUTION')) {
        setAppState(prev => ({
          ...prev,
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`);
            });
          })
        }));
      }
    }

    // Handle speculation acceptance
    if (speculationAccept) {
      const {
        queryRequired
      } = await handleSpeculationAccept(speculationAccept.state, speculationAccept.speculationSessionTimeSavedMs, speculationAccept.setAppState, input, {
        setMessages,
        readFileState,
        cwd: getOriginalCwd()
      });
      if (queryRequired) {
        const newAbortController = createAbortController();
        setAbortController(newAbortController);
        void onQuery([], newAbortController, true, [], mainLoopModel);
      }
      return;
    }

    // Remote mode: send input via stream-json instead of local query.
    // Permission requests from the remote are bridged into toolUseConfirmQueue
    // and rendered using the standard PermissionRequest component.
    //
    // local-jsx slash commands (e.g. /agents, /config) render UI in THIS
    // process — they have no remote equivalent. Let those fall through to
    // handlePromptSubmit so they execute locally. Prompt commands and
    // plain text go to the remote.
    if (activeRemote.isRemoteMode && !(isSlashCommand && commands.find(c => {
      const name = input.trim().slice(1).split(/\s/)[0];
      return isCommandEnabled(c) && (c.name === name || c.aliases?.includes(name!) || getCommandName(c) === name);
    })?.type === 'local-jsx')) {
      // Build content blocks when there are pasted attachments (images)
      const pastedValues = Object.values(pastedContents);
      const imageContents = pastedValues.filter(c => c.type === 'image');
      const imagePasteIds = imageContents.length > 0 ? imageContents.map(c => c.id) : undefined;
      let messageContent: string | ContentBlockParam[] = input.trim();
      let remoteContent: RemoteMessageContent = input.trim();
      if (pastedValues.length > 0) {
        const contentBlocks: ContentBlockParam[] = [];
        const remoteBlocks: Array<{
          type: string;
          [key: string]: unknown;
        }> = [];
        const trimmedInput = input.trim();
        if (trimmedInput) {
          contentBlocks.push({
            type: 'text',
            text: trimmedInput
          });
          remoteBlocks.push({
            type: 'text',
            text: trimmedInput
          });
        }
        for (const pasted of pastedValues) {
          if (pasted.type === 'image') {
            const source = {
              type: 'base64' as const,
              media_type: (pasted.mediaType ?? 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: pasted.content
            };
            contentBlocks.push({
              type: 'image',
              source
            });
            remoteBlocks.push({
              type: 'image',
              source
            });
          } else {
            contentBlocks.push({
              type: 'text',
              text: pasted.content
            });
            remoteBlocks.push({
              type: 'text',
              text: pasted.content
            });
          }
        }
        messageContent = contentBlocks;
        remoteContent = remoteBlocks;
      }

      // Create and add user message to UI
      // Note: empty input already handled by early return above
      const userMessage = createUserMessage({
        content: messageContent,
        imagePasteIds
      });
      setMessages(prev => [...prev, userMessage]);

      // Send to remote session
      await activeRemote.sendMessage(remoteContent, {
        uuid: userMessage.uuid
      });
      return;
    }

    // Ensure SessionStart hook context is available before the first API call.
    await awaitPendingHooks();
    // Idle-gap opportunistic sweep: when the gap since the last assistant
    // message exceeds the time-based microcompact threshold, the server-side
    // cache has expired anyway — so the amortization gates above (post-turn
    // EVICT_MIN_BATCH / EVICT_TRIGGER_AT) would be hoarding evictable
    // messages for a break that is already free. Evict everything evictable
    // now, before this submission seeds the request. The swept array is
    // passed straight to handlePromptSubmit (messagesRef updates via
    // setMessages are not synchronous).
    //
    // Guarded on no query in flight: on the queued-submit path (isLoading,
    // e.g. a turn parked ≥60min at a permission prompt) the in-flight turn
    // keeps using its own unswept array — sweeping the display here would
    // diverge it from the request bytes and turn the next turn's "free"
    // break into a full one. Queued submits skip the sweep; the next
    // non-queued submit picks it up if the gap still qualifies.
    const sweepSnapshot = messagesRef.current;
    let messagesForSubmit = sweepSnapshot;
    if (
      !queryGuard.isActive &&
      evaluateTimeBasedTrigger(sweepSnapshot, getQuerySourceForREPL())
    ) {
      const swept = evictToMaxSize(
        evictOldStubbedMessages(sweepSnapshot as AnyMessage[], 2, 1),
        MAX_DISPLAY_MESSAGES,
        MAX_DISPLAY_MESSAGES,
      ) as MessageType[];
      if (swept !== sweepSnapshot) {
        messagesForSubmit = swept;
        // Preserve anything appended after the snapshot (same-tick races):
        // appends are strictly additive, so re-attach the tail.
        setMessages(prev =>
          prev === sweepSnapshot
            ? swept
            : [...swept, ...prev.slice(sweepSnapshot.length)],
        );
      }
    }
    await handlePromptSubmit({
      input,
      helpers,
      queryGuard,
      isExternalLoading,
      mode: inputMode,
      commands,
      onInputChange: setInputValue,
      setPastedContents,
      setToolJSX,
      getToolUseContext,
      messages: messagesForSubmit,
      mainLoopModel,
      pastedContents,
      ideSelection,
      setUserInputOnProcessing,
      setAbortController,
      abortController,
      onQuery,
      setAppState,
      querySource: getQuerySourceForREPL(),
      onBeforeQuery,
      canUseTool,
      addNotification,
      setMessages,
      // Read via ref so streamMode can be dropped from onSubmit deps —
      // handlePromptSubmit only uses it for debug log + telemetry event.
      streamMode: streamModeRef.current,
      hasInterruptibleToolInProgress: hasInterruptibleToolInProgressRef.current
    });

    // Restore stash that was deferred above. Two cases:
    // - Slash command: handlePromptSubmit awaited the full command execution
    //   (including interactive pickers). Restoring now places the stash back in
    //   the visible input.
    // - Loading (queued): handlePromptSubmit enqueued + cleared input, then
    //   returned quickly. Restoring now places the stash back after the clear.
    if ((isSlashCommand || isLoading) && stashedPrompt !== undefined) {
      setInputValue(stashedPrompt.text);
      helpers.setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    }
  }, [queryGuard,
    // isLoading is read at the !isLoading checks above for input-clearing
    // and submitCount gating. It's derived from isQueryActive || isExternalLoading,
    // so including it here ensures the closure captures the fresh value.
    isLoading, isExternalLoading, inputMode, commands, setInputValue, setInputMode, setPastedContents, setSubmitCount, setIDESelection, setToolJSX, getToolUseContext,
    // messages is read via messagesRef.current inside the callback to
    // keep onSubmit stable across message updates (see L2384/L2400/L2662).
    // Without this, each setMessages call (~30× per turn) recreates
    // onSubmit, pinning the REPL render scope (1776B) + that render's
    // messages array in downstream closures (PromptInput, handleAutoRunIssue).
    // Heap analysis showed ~9 REPL scopes and ~15 messages array versions
    // accumulating after #20174/#20175, all traced to this dep.
    mainLoopModel, pastedContents, ideSelection, setUserInputOnProcessing, setAbortController, addNotification, onQuery, stashedPrompt, setStashedPrompt, setAppState, onBeforeQuery, canUseTool, remoteSession, setMessages, awaitPendingHooks, repinScroll]);

  return onSubmit;
}
