import React, { useCallback } from 'react';
import { Messages } from 'src/agent/ui/Messages.js';
import { previewFooter, useSessionRead } from 'src/sessions/ui/sessionPreview/useSessionRead.js';
import type { LogOption } from 'src/shared/types/logs.js';
import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js';
import { Byline } from 'src/terminal/design-system/Byline.js';
import { LoadingState } from 'src/terminal/design-system/LoadingState.js';
import { Box, Text } from 'src/terminal/ink.js';
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js';
import { getAllBaseTools } from 'src/tools/tools.js';
type Props = {
  log: LogOption;
  onExit: () => void;
  onSelect: (log: LogOption) => void;
};

// The transcript view's inputs that a read-only preview leaves empty. Kept
// stable so the message list is not rebuilt on every render.
const NO_COMMANDS: never[] = [];
const NO_PENDING_TOOLS = new Set<string>();
const NO_CONFIRMATIONS: never[] = [];
const NO_STREAMING: never[] = [];

/** One session's conversation, read-only, with Enter to resume it and Esc to go back. */
export function SessionPreview({ log, onExit, onSelect }: Props): React.ReactNode {
  const { log: shown, loading } = useSessionRead(log);
  const tools = React.useMemo(() => getAllBaseTools(), []);
  const resume = useCallback(() => onSelect(shown), [onSelect, shown]);
  useKeybinding('confirm:yes', resume, { context: 'Confirmation' });
  useKeybinding('confirm:no', onExit, { context: 'Confirmation' });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <LoadingState message="Loading session…" />
        <Text dimColor>
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Messages
        messages={shown.messages}
        tools={tools}
        commands={NO_COMMANDS}
        verbose
        showAllInTranscript
        toolJSX={null}
        toolUseConfirmQueue={NO_CONFIRMATIONS}
        inProgressToolUseIDs={NO_PENDING_TOOLS}
        isMessageSelectorVisible={false}
        conversationId={shown.sessionId ?? 'preview'}
        screen="transcript"
        streamingToolUses={NO_STREAMING}
        isLoading={false}
      />
      <Box flexDirection="column" borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingLeft={2}>
        <Text>{previewFooter(shown)}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint action="confirm:yes" context="Confirmation" fallback="Enter" description="resume" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    </Box>
  );
}
