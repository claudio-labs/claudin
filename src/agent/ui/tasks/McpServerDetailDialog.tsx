// The detail view behind Enter on an MCP server row.
//
// Read-only by design, and deliberately NOT the `/mcp` panel: that one is a
// full-screen management flow (add, remove, authenticate, pick a scope), while
// the question this answers is the one the row just raised — what is this
// server, what does it give me, and if it is down, why. `x` still goes through
// the same disconnect confirmation the list does, and nothing here can write.

import React, { useCallback, useMemo } from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import { Byline } from 'src/terminal/design-system/Byline.js';
import { Dialog } from 'src/terminal/design-system/Dialog.js';
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js';
import { useKeybindings } from 'src/terminal/keybindings/useKeybinding.js';
import { useAppState } from 'src/terminal/state/AppState.js';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import type { ExitState } from 'src/terminal/hooks/useExitOnCtrlCDWithKeybindings.js';
import type { KeyboardEvent } from 'src/terminal/ink/events/keyboard-event.js';
import type { CommandResultDisplay } from 'src/commands/commands.js';
import type { DeepImmutable } from 'src/shared/types/utils.js';
import type { McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js';
import { mcpRowBody, mcpRowGlyph, mcpRowTone } from 'src/agent/ui/tasks/mcpRowLabel.js';
import { getMcpDisplayName, getMcpPrefix } from 'src/mcp/mcpStringUtils.js';

type Props = {
  task: DeepImmutable<McpServerTaskState>;
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  onBack?: () => void;
  onDisconnect?: () => void;
};

/** Tool names listed before the rest are summarised. A server with 60 tools
 * would otherwise push the dialog past a short terminal. */
const VISIBLE_TOOLS = 12;

/** Failure messages are often a whole stack; keep the dialog bounded. */
const ERROR_LINES = 6;

export function McpServerDetailDialog({ task, onDone, onBack, onDisconnect }: Props): React.ReactNode {
  const allTools = useAppState((s: AppState) => s.mcp.tools);

  // Read from the live pool rather than off the row: the row carries a count,
  // and a count is what it should carry — names change on every reconnect.
  const toolNames = useMemo(() => {
    const prefix = getMcpPrefix(task.serverName);
    return allTools
      .map(t => t.name)
      .filter((name): name is string => typeof name === 'string' && name.startsWith(prefix))
      .map(name => getMcpDisplayName(name, task.serverName))
      .sort();
  }, [allTools, task.serverName]);

  const handleClose = useCallback(
    () => onDone('MCP server details dismissed', { display: 'system' }),
    [onDone],
  );

  useKeybindings({ 'confirm:yes': handleClose }, { context: 'Confirmation' });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      handleClose();
    } else if (e.key === 'left' && onBack) {
      e.preventDefault();
      onBack();
    } else if (e.key === 'x' && onDisconnect) {
      e.preventDefault();
      onDisconnect();
    }
  };

  const renderInputGuide = (exitState: ExitState): React.ReactNode => {
    if (exitState.pending) {
      return <Text>Press {exitState.keyName} again to exit</Text>;
    }
    return (
      <Byline>
        {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
        <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
        {onDisconnect && <KeyboardShortcutHint shortcut="x" action="disconnect" />}
      </Byline>
    );
  };

  const errorLines =
    task.connectionType === 'failed' && task.error
      ? task.error.split('\n').slice(0, ERROR_LINES)
      : [];

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={`MCP · ${task.serverName}`}
        subtitle={
          <Text>
            <Text color={mcpRowTone(task)}>{mcpRowGlyph(task)} </Text>
            {mcpRowBody(task)}
          </Text>
        }
        onCancel={handleClose}
        color="background"
        inputGuide={renderInputGuide}
      >
        <Box marginX={2} flexDirection="column">
          <Text>
            <Text bold>Transport:</Text> {task.transport} · <Text bold>Scope:</Text>{' '}
            {task.scope}
          </Text>
          {task.serverInfo && (
            <Text>
              <Text bold>Server:</Text> {task.serverInfo.name} v{task.serverInfo.version}
            </Text>
          )}
          {task.resourceCount > 0 && (
            <Text>
              <Text bold>Resources:</Text> {task.resourceCount}
            </Text>
          )}
        </Box>
        {errorLines.length > 0 && (
          <Box marginX={2} marginTop={1} flexDirection="column">
            <Text bold>Error</Text>
            {errorLines.map((line, i) => (
              <Text key={i} color="error" wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        )}
        <ToolSection names={toolNames} />
      </Dialog>
    </Box>
  );
}

function ToolSection({ names }: { names: readonly string[] }): React.ReactNode {
  if (names.length === 0) {
    return (
      <Box marginX={2} marginTop={1}>
        <Text dimColor>This server contributes no tools.</Text>
      </Box>
    );
  }
  const shown = names.slice(0, VISIBLE_TOOLS);
  const hidden = names.length - shown.length;
  return (
    <Box marginX={2} marginTop={1} flexDirection="column">
      <Text bold>Tools ({names.length})</Text>
      {shown.map(name => (
        <Text key={name} dimColor wrap="truncate-end">
          {'  '}
          {name}
        </Text>
      ))}
      {hidden > 0 && <Text dimColor italic>{'  '}and {hidden} more</Text>}
    </Box>
  );
}
