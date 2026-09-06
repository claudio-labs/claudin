// The detail view behind Enter on a container row: the last 50 log lines.
//
// Until now a container was the one task type with no detail view, so Enter was
// wired to do nothing. `docker logs --tail 50` is what a user actually wants
// from that keypress — the row already says the container is restarting, and
// the next question is always why.
//
// Read-only by design. `x` still goes through the same stop confirmation as the
// list, and nothing here can write to the container.

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import { Byline } from 'src/terminal/design-system/Byline.js';
import { Dialog } from 'src/terminal/design-system/Dialog.js';
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js';
import { useKeybindings } from 'src/terminal/keybindings/useKeybinding.js';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import type { ExitState } from 'src/terminal/hooks/useExitOnCtrlCDWithKeybindings.js';
import type { KeyboardEvent } from 'src/terminal/ink/events/keyboard-event.js';
import type { CommandResultDisplay } from 'src/commands/commands.js';
import type { DeepImmutable } from 'src/shared/types/utils.js';
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js';
import { containerRowLabel, shortContainerName } from 'src/agent/ui/tasks/containerRowLabel.js';
import {
  CONTAINER_LOG_TAIL,
  fetchContainerLogs,
  hasOwnTimestamp,
  type ContainerLogs,
} from 'src/agent/ui/tasks/containerLogs.js';

type Props = {
  task: DeepImmutable<ContainerTaskState>;
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  onBack?: () => void;
  onStop?: () => void;
};

/** Lines kept on screen. Below the 50 fetched, so the box does not outgrow a
 * short terminal; the byline says when it is showing fewer than it has. */
const VISIBLE_LINES = 14;

/** Only while the container is running — a stopped one cannot write more. */
const REFRESH_MS = 2_000;

export function ContainerLogsDialog({ task, onDone, onBack, onStop }: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const [logs, setLogs] = useState<ContainerLogs | null>(null);

  const containerId = task.container.id;
  const isRunning = task.container.state === 'running';

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      const next = await fetchContainerLogs(containerId, controller.signal);
      // The abort above makes the in-flight call return an error result rather
      // than reject, so the unmount guard is what keeps it off a dead component.
      if (!cancelled) setLogs(next);
    };
    void load();
    if (!isRunning) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [containerId, isRunning]);

  const handleClose = useCallback(
    () => onDone('Container logs dismissed', { display: 'system' }),
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
    } else if (e.key === 'x' && onStop) {
      e.preventDefault();
      onStop();
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
        {onStop && <KeyboardShortcutHint shortcut="x" action="stop container" />}
      </Byline>
    );
  };

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={`Logs · ${shortContainerName(task.container)}`}
        subtitle={<Text>{containerRowLabel(task)}</Text>}
        onCancel={handleClose}
        color="background"
        inputGuide={renderInputGuide}
      >
        <Box marginX={2} flexDirection="column">
          <Text>
            <Text bold>Image:</Text> {task.container.image}
          </Text>
        </Box>
        <LogBody logs={logs} columns={columns} />
      </Dialog>
    </Box>
  );
}

function LogBody({
  logs,
  columns,
}: {
  logs: ContainerLogs | null;
  columns: number;
}): React.ReactNode {
  if (logs === null) {
    return (
      <Box marginX={2}>
        <Text dimColor>Loading logs…</Text>
      </Box>
    );
  }
  if (logs.kind === 'error') {
    return (
      <Box marginX={2} flexDirection="column">
        <Text color="error">{logs.message}</Text>
      </Box>
    );
  }
  if (logs.kind === 'empty') {
    return (
      <Box marginX={2} flexDirection="column">
        <Text dimColor>No logs written yet.</Text>
      </Box>
    );
  }
  const shown = logs.lines.slice(-VISIBLE_LINES);
  return (
    <Box marginX={2} flexDirection="column">
      <Box
        borderStyle="round"
        paddingX={1}
        flexDirection="column"
        height={VISIBLE_LINES + 2}
        maxWidth={columns - 6}
      >
        {shown.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line.time !== null && line.text !== '' && !hasOwnTimestamp(line.text) && (
              <Text dimColor>{line.time} </Text>
            )}
            {line.text}
          </Text>
        ))}
      </Box>
      <Text dimColor italic>
        Showing {shown.length} of the last {CONTAINER_LOG_TAIL} lines
      </Text>
    </Box>
  );
}
