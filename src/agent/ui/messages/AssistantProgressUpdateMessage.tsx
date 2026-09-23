import React from 'react';
import { Box, NoSelect, Text } from 'src/terminal/ink.js';
import { Markdown } from 'src/terminal/markdown/Markdown.js';

type Props = {
  text: string;
  addMargin: boolean;
};

/**
 * A progress update (isProgressUpdateBlock in thinkingDisplay.ts): the
 * sentence the model writes for the user before a tool call, under
 * `display: "updates"`. It is a status line, not reasoning, so it shows in the
 * prompt view as well as in ctrl+o, right where it arrived — just above the
 * tool call it introduces. Dim, so it never reads as a reply.
 */
export function AssistantProgressUpdateMessage({ text, addMargin }: Props): React.ReactNode {
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} width="100%">
      <NoSelect fromLeftEdge={true} minWidth={2}>
        <Text dimColor={true}>∴</Text>
      </NoSelect>
      <Box flexDirection="column" flexShrink={1}>
        <Markdown dimColor={true}>{text}</Markdown>
      </Box>
    </Box>
  );
}
