// Owns `onSubmit` — the prompt-submission controller: immediate slash commands,
// history, stash restore, the idle-gap
// eviction sweep, and the handoff to handlePromptSubmit.
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
// The dependency array at the bottom is verbatim, including its load-bearing
// oddity - do not "clean" it:
//   * `messages` is deliberately ABSENT. It is read through `messagesRef.current`
//     so onSubmit stays stable across message updates; adding it back recreates
//     onSubmit ~30x per turn and pins the REPL render scope (1776B) plus that
//     render's messages array in downstream closures (PromptInput,
//     handleAutoRunIssue). Heap analysis after #20174/#20175 found ~9 REPL scopes
//     and ~15 messages array versions accumulating, all traced to that dep.

import { useCallback } from 'react';
import { feature } from 'bun:bundle';
import { logForDebugging } from 'src/shared/debug.js';
import { type Command, type CommandResultDisplay, getCommandName, isCommandEnabled } from 'src/commands/commands.js';
import type { PromptInputMode } from 'src/shared/types/textInputTypes.js';
import { addToHistory, expandPastedTextRefs, parseReferences } from 'src/agent/history.js';
import { prependModeCharacterToInput } from 'src/terminal/prompt-input/inputModes.js';
import { prependToShellHistoryCache } from 'src/terminal/suggestions/shellHistoryCompletion.js';
import { type PastedContent } from 'src/platform/config/config.js';
import { createUserMessage, createCommandInputMessage, formatCommandInputTags } from 'src/agent/messages/messages.js';
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/shared/constants/xml.js';
import { escapeXml } from 'src/shared/data/xml.js';
import { handlePromptSubmit, type PromptInputHelpers } from 'src/agent/handlePromptSubmit.js';
import type { Message as MessageType } from 'src/shared/types/message.js';
import { getQuerySourceForREPL } from 'src/agent/promptCategory.js';
import { incrementPromptCount } from 'src/vcs/git/commitAttribution.js';
import { recordAttributionSnapshot } from 'src/sessions/sessionStorage.js';
import { type SetAppState } from 'src/agent/messageQueueManager.js';
import { getCurrentLocalJSXGeneration } from 'src/terminal/toolJSXStore.js';
import { createAbortController } from 'src/shared/abortController.js';
import { acquireFullscreenLease, canLeaseFullscreen, isFullscreenEnvEnabled } from 'src/terminal/render/fullscreen.js';
import type { QueryGuard } from 'src/agent/QueryGuard.js';
import type { IDESelection } from 'src/platform/ide/useIdeSelection.js';
import type { SpinnerMode } from 'src/terminal/spinner/Spinner.js';
import type { ProcessUserInputContext } from 'src/agent/input/processUserInput.js';
import type { EffortValue } from 'src/providers/effort/effort.js';
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js';
import type { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js';
import type { useNotifications } from 'src/terminal/contexts/notifications.js';
import type { useDeferredHookMessages } from 'src/agent/hooks/useDeferredHookMessages.js';

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
  // --- input state
  inputMode: PromptInputMode;
  pastedContents: Record<number, PastedContent>;
  stashedPrompt: StashedPrompt | undefined;
  // --- refs (stable; intentionally absent from the dep array)
  messagesRef: React.RefObject<MessageType[]>;
  inputValueRef: React.RefObject<string>;
  readFileState: React.RefObject<ReturnType<typeof createFileStateCacheWithSizeLimit>>;
  streamModeRef: React.RefObject<SpinnerMode>;
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
    fullscreenLease?: () => void;
  } | null) => void;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  repinScroll: () => void;
  resetTimingRefs: () => void;
}

export type OnSubmit = (
  input: string,
  helpers: PromptInputHelpers,
  speculationAccept?: undefined,
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
    inputMode,
    pastedContents,
    stashedPrompt,
    messagesRef,
    inputValueRef,
    readFileState,
    streamModeRef,
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
    setUserInputOnProcessing,
    setToolJSX,
    addNotification,
    repinScroll,
    resetTimingRefs,
  } = deps;

  const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers, _speculationAccept?: undefined, options?: {
    fromKeybinding?: boolean;
  }) => {
    // Re-pin scroll to bottom on submit so the user always sees the new
    // exchange (matches OpenCode's auto-scroll behavior).
    repinScroll();

    // Handle immediate commands - these bypass the queue and execute right away
    // even while Claude is processing. Commands opt-in via `immediate: true`.
    // Commands triggered via keybindings are always treated as immediate.
    if (input.trim().startsWith('/')) {
      // Expand [Pasted text #N] refs so immediate commands (e.g. /btw) receive
      // the pasted content, not the placeholder. The non-immediate path gets
      // this expansion later in handlePromptSubmit.
      const trimmedInput = expandPastedTextRefs(input, pastedContents).trim();
      const spaceIndex = trimmedInput.indexOf(' ');
      const commandName = spaceIndex === -1 ? trimmedInput.slice(1) : trimmedInput.slice(1, spaceIndex);
      const commandArgs = spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim();

      // Find matching command - treat as immediate if:
      // 1. Command has `immediate: true`, OR
      // 2. Command was triggered via keybinding (fromKeybinding option), OR
      // 3. It opens a fullscreen side panel, which by definition sits BESIDE
      //    the running turn rather than over it — queueing it until the turn
      //    ends is the one thing a reviewer must not do. An inline session gets
      //    the panel through a fullscreen lease; only where no lease is to be
      //    had (the inline dialog, prompt hidden under it) keeps today's route.
      const matchingCommand = commands.find(cmd => isCommandEnabled(cmd) && (cmd.name === commandName || cmd.aliases?.includes(commandName) || getCommandName(cmd) === commandName));
      const shouldTreatAsImmediate = queryGuard.isActive && (matchingCommand?.immediate || options?.fromKeybinding || (matchingCommand?.fullscreenPanel === true && (isFullscreenEnvEnabled() || canLeaseFullscreen())));
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
              generation,
              // Same lease as the queued path (processSlashCommand), so a
              // keybinding that opens one mid-turn still gets the full screen.
              fullscreenLease: matchingCommand.fullscreenLayout === true && canLeaseFullscreen() ? acquireFullscreenLease() : undefined
            });
          }
        };
        void executeImmediateCommand();
        return; // Always return early - don't add to history or queue
      }
    }

    // Add to history for direct user submissions.
    // Queued command processing (executeQueuedInput) doesn't call onSubmit,
    // so notifications and already-queued user input won't be added to history here.
    // Skip history for keybinding-triggered commands (user didn't type the command).
    if (!options?.fromKeybinding) {
      addToHistory({
        display: prependModeCharacterToInput(input, inputMode),
        pastedContents
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
    // In both deferred cases, the stash is restored after await handlePromptSubmit.
    const isSlashCommand = input.trim().startsWith('/');
    // Submit runs "now" (not queued) when not already loading.
    const submitsNow = !isLoading;
    if (stashedPrompt !== undefined && !isSlashCommand && submitsNow) {
      setInputValue(stashedPrompt.text);
      helpers.setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    } else if (submitsNow) {
      if (!options?.fromKeybinding) {
        // Clear input when not loading.
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
      // Skip for slash/bash (they have their own echo).
      if (!isSlashCommand && inputMode === 'prompt') {
        setUserInputOnProcessing(input);
        // showSpinner includes userInputOnProcessing, so the spinner appears
        // on this render. Reset timing refs now (before queryGuard.reserve()
        // would) so elapsed time doesn't read as Date.now() - 0. The
        // isQueryActive transition above does the same reset — idempotent.
        resetTimingRefs();
      }

    }

    // Ensure SessionStart hook context is available before the first API call.
    await awaitPendingHooks();
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
      messages: messagesRef.current,
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
    mainLoopModel, pastedContents, ideSelection, setUserInputOnProcessing, setAbortController, addNotification, onQuery, stashedPrompt, setStashedPrompt, setAppState, onBeforeQuery, canUseTool, setMessages, awaitPendingHooks, repinScroll]);

  return onSubmit;
}
