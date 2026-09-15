import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React, { useContext, useMemo } from 'react';
import { Box } from 'src/terminal/ink.js';
import { logError } from 'src/shared/log.js';
import { countCharInString } from 'src/shared/text/stringUtils.js';
import { MessageActionsSelectedContext } from 'src/agent/ui/messageActions.js';
import { HighlightedThinkingText } from 'src/agent/ui/messages/HighlightedThinkingText.js';
type Props = {
  addMargin: boolean;
  param: TextBlockParam;
  /** Unused: the brief layout it selected is compiled out. */
  isTranscriptMode?: boolean;
  /** Unused: only rendered by the brief layout, which is compiled out. */
  timestamp?: string;
};

// Hard cap on displayed prompt text. Piping large files via stdin
// (e.g. `cat 11k-line-file | claude`) creates a single user message whose
// <Text> node the fullscreen Ink renderer must wrap/output on every frame,
// causing 500ms+ keystroke latency. React.memo skips the React render but
// the Ink output pass still iterates the full mounted text. Non-fullscreen
// avoids this via <Static> (print-and-forget to terminal scrollback).
// Head+tail because `{ cat file; echo prompt; } | claude` puts the user's
// actual question at the end.
const MAX_DISPLAY_CHARS = 10_000;
const TRUNCATE_HEAD_CHARS = 2_500;
const TRUNCATE_TAIL_CHARS = 2_500;
export function UserPromptMessage({
  addMargin,
  param: {
    text
  }
}: Props): React.ReactNode {
  // Truncate before the early return so the hook order is stable.
  const displayText = useMemo(() => {
    if (text.length <= MAX_DISPLAY_CHARS) return text;
    const head = text.slice(0, TRUNCATE_HEAD_CHARS);
    const tail = text.slice(-TRUNCATE_TAIL_CHARS);
    const hiddenLines = countCharInString(text, '\n', TRUNCATE_HEAD_CHARS) - countCharInString(tail, '\n');
    return `${head}\n… +${hiddenLines} lines …\n${tail}`;
  }, [text]);
  const isSelected = useContext(MessageActionsSelectedContext);
  if (!text) {
    logError(new Error('No content found in user prompt message'));
    return null;
  }
  return <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={isSelected ? 'messageActionsBackground' : 'userMessageBackground'} paddingRight={1}>
      <HighlightedThinkingText text={displayText} useBriefLayout={false} timestamp={undefined} />
    </Box>;
}
