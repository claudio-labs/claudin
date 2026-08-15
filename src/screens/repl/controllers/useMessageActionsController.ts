// Owns conversation rewind / message restore and the message-action caps
// (copy, edit) the MessageActions keybinding layer dispatches into.
//
// Extracted from src/screens/REPL.tsx (controllers, ROADMAP 11e deferred half).
// Before extraction these six declarations sat consecutively between
// `handleShowMessageSelector` and the `useMessageActions(...)` call, in this
// order: rewindConversationTo, restoreMessageSync, the
// `restoreMessageSyncRef.current = …` render-phase assignment,
// handleRestoreMessage, findRawIndex, messageActionCaps.
//
// IMPORTANT — hook order: REPL.tsx invokes `useMessageActionsController(...)`
// at exactly the position `rewindConversationTo` occupied, and this file calls
// the same three `useCallback`s in the same order with verbatim dependency
// arrays. Net change to the component's hook-call sequence: three hooks
// collapse into one call that performs those same three — order preserved.
//
// The `restoreMessageSyncRef.current = restoreMessageSync` write is a RENDER-
// PHASE assignment and stays one, executed inside this hook at the same point
// in the render. It is not incidental: `onQuery`'s auto-restore path (declared
// EARLIER in the component) reaches restoreMessageSync only through this ref,
// because the callback itself is declared later and would otherwise be in the
// temporal dead zone. Do not convert it to an effect — the auto-restore fires
// from an abort handler that can run before effects flush.
//
// `findRawIndex` and `messageActionCaps` are deliberately NOT memoized: the
// messageActions hook stores caps via a ref and reads the latest closure at
// dispatch time, so memoizing them would pin a stale `messages` array.
// The 24-char uuid prefix match is load-bearing — deriveUUID preserves the
// first 24 chars, so a renderable message's uuid prefix-matches its raw source.

import { useCallback } from 'react';
import { feature } from 'bun:bundle';
import { randomUUID, type UUID } from 'crypto';
import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import type { Message as MessageType, UserMessage } from 'src/types/message.js';
import type { PastedContent } from 'src/services/config/config.js';
import type { MessageActionCaps } from 'src/components/messageActions.js';
import type { FileHistoryState } from 'src/shared/fs/fileHistory.js';
import type { PromptInputMode } from 'src/types/textInputTypes.js';
import type { SetAppState } from 'src/utils/messageQueueManager.js';
import type { useNotifications } from 'src/context/notifications.js';
import {
  selectableUserMessagesFilter,
  messagesAfterAreOnlySynthetic,
} from 'src/components/MessageSelector.js';
import { textForResubmit } from 'src/services/messages/messages.js';
import { resetMicrocompactState } from 'src/services/compact/microCompact.js';
import { fileHistoryHasAnyChanges } from 'src/shared/fs/fileHistory.js';
import { setClipboard } from 'src/ink/termio/osc.js';
import { logEvent } from 'src/services/analytics/index.js';

export interface UseMessageActionsControllerDeps {
  messages: MessageType[];
  messagesRef: React.RefObject<MessageType[]>;
  restoreMessageSyncRef: React.RefObject<(m: UserMessage) => void>;
  fileHistory: FileHistoryState;
  setMessages: (action: React.SetStateAction<MessageType[]>) => void;
  setAppState: SetAppState;
  setConversationId: React.Dispatch<React.SetStateAction<UUID>>;
  setInputValue: (value: string) => void;
  setInputMode: React.Dispatch<React.SetStateAction<PromptInputMode>>;
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>;
  setMessageSelectorPreselect: React.Dispatch<React.SetStateAction<UserMessage | undefined>>;
  setIsMessageSelectorVisible: React.Dispatch<React.SetStateAction<boolean>>;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  onCancel: () => void;
}

export interface UseMessageActionsControllerResult {
  handleRestoreMessage: (message: UserMessage) => Promise<void>;
  messageActionCaps: MessageActionCaps;
}

export function useMessageActionsController(
  deps: UseMessageActionsControllerDeps,
): UseMessageActionsControllerResult {
  const {
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
  } = deps;

  // Rewind conversation state to just before `message`: slice messages,
  // reset conversation ID, microcompact state, permission mode, prompt suggestion.
  // Does NOT touch the prompt input. Index is computed from messagesRef (always
  // fresh via the setMessages wrapper) so callers don't need to worry about
  // stale closures.
  const rewindConversationTo = useCallback((message: UserMessage) => {
    const prev = messagesRef.current;
    const messageIndex = prev.lastIndexOf(message);
    if (messageIndex === -1) return;
    logEvent('tengu_conversation_rewind', {
      preRewindMessageCount: prev.length,
      postRewindMessageCount: messageIndex,
      messagesRemoved: prev.length - messageIndex,
      rewindToMessageIndex: messageIndex
    });
    setMessages(prev.slice(0, messageIndex));
    // Careful, this has to happen after setMessages
    setConversationId(randomUUID());
    // Reset cached microcompact state so stale pinned cache edits
    // don't reference tool_use_ids from truncated messages
    resetMicrocompactState();
    if (feature('CONTEXT_COLLAPSE')) {
      // Rewind truncates the REPL array. Commits whose archived span
      // was past the rewind point can't be projected anymore
      // (projectView silently skips them) but the staged queue and ID
      // maps reference stale uuids. Simplest safe reset: drop
      // everything. The ctx-agent will re-stage on the next
      // threshold crossing.
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;
      (require('src/services/contextCollapse/index.js') as typeof import('src/services/contextCollapse/index.js')).resetContextCollapse();
      /* eslint-enable @typescript-eslint/no-require-imports */
    }

    // Restore state from the message we're rewinding to
    setAppState(prev => ({
      ...prev,
      // Restore permission mode from the message
      toolPermissionContext: message.permissionMode && prev.toolPermissionContext.mode !== message.permissionMode ? {
        ...prev.toolPermissionContext,
        mode: message.permissionMode
      } : prev.toolPermissionContext,
      // Clear stale prompt suggestion from previous conversation state
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      }
    }));
  }, [setMessages, setAppState]);

  // Synchronous rewind + input population. Used directly by auto-restore on
  // interrupt (so React batches with the abort's setMessages → single render,
  // no flicker). MessageSelector wraps this in setImmediate via handleRestoreMessage.
  const restoreMessageSync = useCallback((message: UserMessage) => {
    rewindConversationTo(message);
    const r = textForResubmit(message);
    if (r) {
      setInputValue(r.text);
      setInputMode(r.mode);
    }

    // Restore pasted images
    if (Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'image')) {
      const imageBlocks: Array<ImageBlockParam> = message.message.content.filter(block => block.type === 'image');
      if (imageBlocks.length > 0) {
        const newPastedContents: Record<number, PastedContent> = {};
        imageBlocks.forEach((block, index) => {
          if (block.source.type === 'base64') {
            const id = message.imagePasteIds?.[index] ?? index + 1;
            newPastedContents[id] = {
              id,
              type: 'image',
              content: block.source.data,
              mediaType: block.source.media_type
            };
          }
        });
        setPastedContents(newPastedContents);
      }
    }
  }, [rewindConversationTo, setInputValue]);
  restoreMessageSyncRef.current = restoreMessageSync;

  // MessageSelector path: defer via setImmediate so the "Interrupted" message
  // renders to static output before rewind — otherwise it remains vestigial
  // at the top of the screen.
  const handleRestoreMessage = useCallback(async (message: UserMessage) => {
    setImmediate((restore, message) => restore(message), restoreMessageSync, message);
  }, [restoreMessageSync]);

  // Not memoized — hook stores caps via ref, reads latest closure at dispatch.
  // 24-char prefix: deriveUUID preserves first 24, renderable uuid prefix-matches raw source.
  const findRawIndex = (uuid: string) => {
    const prefix = uuid.slice(0, 24);
    return messages.findIndex(m => m.uuid.slice(0, 24) === prefix);
  };
  const messageActionCaps: MessageActionCaps = {
    copy: text =>
      // setClipboard RETURNS OSC 52 — caller must stdout.write (tmux side-effects load-buffer, but that's tmux-only).
      void setClipboard(text).then(raw => {
        if (raw) process.stdout.write(raw);
        addNotification({
          // Same key as text-selection copy — repeated copies replace toast, don't queue.
          key: 'selection-copied',
          text: 'copied',
          color: 'success',
          priority: 'immediate',
          timeoutMs: 2000
        });
      }),
    edit: async msg => {
      // Same skip-confirm check as /rewind: lossless → direct, else confirm dialog.
      const rawIdx = findRawIndex(msg.uuid);
      const raw = rawIdx >= 0 ? messages[rawIdx] : undefined;
      if (!raw || !selectableUserMessagesFilter(raw)) return;
      const noFileChanges = !(await fileHistoryHasAnyChanges(fileHistory, raw.uuid));
      const onlySynthetic = messagesAfterAreOnlySynthetic(messages, rawIdx);
      if (noFileChanges && onlySynthetic) {
        // rewindConversationTo's setMessages races stream appends — cancel first (idempotent).
        onCancel();
        // handleRestoreMessage also restores pasted images.
        void handleRestoreMessage(raw);
      } else {
        // Dialog path: onPreRestore (= onCancel) fires when user CONFIRMS, not on nevermind.
        setMessageSelectorPreselect(raw);
        setIsMessageSelectorVisible(true);
      }
    }
  };

  return { handleRestoreMessage, messageActionCaps };
}
