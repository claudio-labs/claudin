import { feature } from 'bun:bundle';
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { Box, Text, useInput } from '../../ink.js';
import { ContextVisualization } from '../../components/ContextVisualization.js';
import { DOWN_ARROW, UP_ARROW } from '../../constants/figures.js';
import { useModalOrTerminalSize } from '../../context/modalContext.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js';
import { microcompactMessages } from '../../services/compact/microCompact.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { Message } from '../../types/message.js';
import { analyzeContextUsage, type ContextData } from '../../utils/analyzeContext.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';

// Rows reserved for the panel's own footer + the REPL chrome below it, so the
// scroll viewport never runs past the bottom of the terminal.
const CHROME_ROWS = 4;
const SCROLL_LINES = 3;

/**
 * Wraps the context grid so the panel can dismiss itself. A bare
 * <ContextVisualization> mounted as command output has no way to call onDone,
 * so the REPL keeps the local-jsx slot open and the user can't return to the
 * prompt. Esc/Enter (and ctrl+c twice) close it.
 *
 * The grid is taller than the terminal for most sessions (MCP tools, agents,
 * skills, and memory files all stack), so it's mounted in a height-capped
 * ScrollBox — otherwise the top of the grid scrolls off-screen and the rest
 * is clipped with no way to reach it. Up/down (and ctrl+p/ctrl+n) scroll.
 */
function ContextPanel({
  data,
  onDone,
}: {
  data: ContextData;
  onDone: LocalJSXCommandOnDone;
}): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle>(null);
  const { rows } = useModalOrTerminalSize(useTerminalSize());
  const close = React.useCallback(
    () => onDone('Context dialog dismissed', { display: 'system' }),
    [onDone],
  );
  const exitState = useExitOnCtrlCDWithKeybindings(close);
  useInput((input, key) => {
    if (key.escape || key.return) {
      close();
      return;
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      scrollRef.current?.scrollBy(-SCROLL_LINES);
      return;
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      scrollRef.current?.scrollBy(SCROLL_LINES);
    }
  });
  const maxContentHeight = Math.max(5, rows - CHROME_ROWS);
  return (
    <Box flexDirection="column">
      <Box maxHeight={maxContentHeight}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          <ContextVisualization data={data} />
        </ScrollBox>
      </Box>
      <Text dimColor>
        {exitState.pending
          ? `Press ${exitState.keyName} again to exit`
          : `${UP_ARROW}/${DOWN_ARROW} to scroll · esc or enter to close`}
      </Text>
    </Box>
  );
}

/**
 * Apply the same context transforms query.ts does before the API call, so
 * /context shows what the model actually sees rather than the REPL's raw
 * history. Without projectView the token count overcounts by however much
 * was collapsed — user sees "180k, 3 spans collapsed" when the API sees 120k.
 */
function toApiView(messages: Message[]): Message[] {
  let view = getMessagesAfterCompactBoundary(messages);
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      projectView
    } = require('../../services/contextCollapse/operations.js') as typeof import('../../services/contextCollapse/operations.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    view = projectView(view);
  }
  return view;
}
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const {
    messages,
    getAppState,
    options: {
      mainLoopModel,
      tools
    }
  } = context;
  const apiView = toApiView(messages);

  // Apply microcompact to get accurate representation of messages sent to API
  const {
    messages: compactedMessages
  } = await microcompactMessages(apiView);

  // Get terminal width for responsive sizing
  const terminalWidth = process.stdout.columns || 80;
  const appState = getAppState();

  // Analyze context with compacted messages
  // Pass original messages as last parameter for accurate API usage extraction
  const data = await analyzeContextUsage(compactedMessages, mainLoopModel, async () => appState.toolPermissionContext, tools, appState.agentDefinitions, terminalWidth, context,
  // Pass full context for system prompt calculation
  undefined,
  // mainThreadAgentDefinition
  apiView // Original messages for API usage extraction
  );

  // Return the panel as JSX so the REPL mounts it as a dismissible command
  // output above the prompt. Routing it through onDone(string) instead would
  // funnel the multi-line grid into the footer's one-line truncated
  // notification slot, where it auto-dismisses and renders blank.
  return <ContextPanel data={data} onDone={onDone} />;
}
