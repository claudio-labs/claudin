import React from 'react';
import { progressUpdateHint } from 'src/providers/shims/claude/thinkingDisplay.js';
import { BLACK_CIRCLE } from 'src/shared/constants/figures.js';
import { Box, NoSelect, Text } from 'src/terminal/ink.js';
import { Markdown } from 'src/terminal/markdown/Markdown.js';

type Props = {
  text: string;
  addMargin: boolean;
  shouldShowDot: boolean;
  /** The model that wrote the update: it decides the trailing hint. */
  model?: string;
};

/**
 * A progress update (isProgressUpdateBlock in thinkingDisplay.ts): the
 * sentence the model writes for the user before a tool call, under
 * `display: "updates"`. It shows in the prompt view as well as in ctrl+o,
 * right where it arrived — just above the tool call it introduces.
 *
 * Drawn as Claude Code 2.1.281 draws it: a reply, with the assistant dot and
 * normal text, and the dim hint progressUpdateHint picks for the model. The ∴
 * it used to wear is the thinking glyph, and read as leaked reasoning.
 */
export function AssistantProgressUpdateMessage({ text, addMargin, shouldShowDot, model }: Props): React.ReactNode {
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} width="100%">
      {shouldShowDot && (
        <NoSelect fromLeftEdge={true} minWidth={2}>
          <Text color="text">{BLACK_CIRCLE}</Text>
        </NoSelect>
      )}
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Markdown hint={progressUpdateHint(model)}>{text}</Markdown>
      </Box>
    </Box>
  );
}
