// Detail view for a monitor_mcp task: which server, which kind, where it is,
// and the tail of what it wrote. Opened from the background-tasks dialog,
// which owns closing — so every close key here goes back to it.
//
// The task is pinned while the view is open, so one that ends under the
// reader stays on screen instead of being evicted out from under the dialog.
//
// Hand-written, not React-Compiler output.

import React, { Suspense, useDeferredValue, useEffect, useRef, useState } from 'react';
import type { MonitorMcpTaskState } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js';
import { monitorMcpKindLabel } from 'src/agent/tasks/MonitorMcpTask/notification.js';
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js';
import { pinTerminalTask, releaseTerminalTask } from 'src/agent/tasks/framework.js';
import { ShellOutputContent } from 'src/agent/ui/tasks/ShellDetailDialog.js';
import { getTaskStatusColor } from 'src/agent/ui/tasks/taskStatusUtils.js';
import { isENOENT } from 'src/shared/errors.js';
import { tailFile } from 'src/shared/fs/fsOperations.js';
import { logError } from 'src/shared/log.js';
import { formatDuration } from 'src/shared/text/format.js';
import type { DeepImmutable } from 'src/shared/types/utils.js';
import { Byline } from 'src/terminal/design-system/Byline.js';
import { Dialog } from 'src/terminal/design-system/Dialog.js';
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js';
import type { ExitState } from 'src/terminal/hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import type { KeyboardEvent } from 'src/terminal/ink/events/keyboard-event.js';
import { Box, Text } from 'src/terminal/ink.js';
import { useKeybindings } from 'src/terminal/keybindings/useKeybinding.js';
import { useSetAppState } from 'src/terminal/state/AppState.js';

const TAIL_BYTES = 8192;
const REFRESH_MS = 1000;

type OutputTail = { content: string; bytesTotal: number };

type Task = DeepImmutable<MonitorMcpTaskState>;

type Props = {
  task: Task;
  onKill?: () => void;
  onBack: () => void;
};

async function readOutputTail(taskId: string): Promise<OutputTail> {
  try {
    const { content, bytesTotal } = await tailFile(getTaskOutputPath(taskId), TAIL_BYTES);
    return { content, bytesTotal };
  } catch (e) {
    if (!isENOENT(e)) logError(e);
    return { content: '', bytesTotal: 0 };
  }
}

/** The status line: status, then how long, then the producer's own words. */
export function monitorMcpStatusLine(task: Task, now: number): string {
  const parts: string[] = [task.status, formatDuration((task.endTime ?? now) - task.startTime)];
  if (task.statusMessage) parts.push(task.statusMessage);
  return parts.join(' · ');
}

type DetailProps = Props & { outputPromise: Promise<OutputTail>; columns: number };

/** What a key does here: Space and ← go back (Esc and Enter come through Dialog
 * and the Confirmation binding), `x` stops a task that can still be stopped. */
export function monitorMcpDetailKeyAction(key: string, canStop: boolean): 'back' | 'stop' | null {
  if (key === ' ' || key === 'left') return 'back';
  if (key === 'x' && canStop) return 'stop';
  return null;
}

/** The dialog's body over an output read the caller owns. */
export function MonitorMcpDetail({ task, onKill, onBack, outputPromise, columns }: DetailProps): React.ReactNode {
  const canStop = task.status === 'running' && onKill !== undefined;
  useKeybindings({ 'confirm:yes': onBack }, { context: 'Confirmation' });
  const handleKeyDown = (e: KeyboardEvent) => {
    const action = monitorMcpDetailKeyAction(e.key, canStop);
    if (!action) return;
    e.preventDefault();
    if (action === 'back') onBack();
    else onKill?.();
  };
  const inputGuide = (exitState: ExitState) => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline>
        <KeyboardShortcutHint shortcut={'Esc/\u2190'} action="go back" />
        {canStop && <KeyboardShortcutHint shortcut="x" action="stop" />}
      </Byline>;
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog title={task.description} subtitle={<Text dimColor>{monitorMcpKindLabel(task.kind)} · {task.serverName}</Text>} onCancel={onBack} color="background" inputGuide={inputGuide}>
        <Text color={getTaskStatusColor(task.status)}>{monitorMcpStatusLine(task, Date.now())}</Text>
        <Suspense fallback={<Text dimColor>Loading output…</Text>}>
          <ShellOutputContent outputPromise={outputPromise} columns={columns} />
        </Suspense>
      </Dialog>
    </Box>;
}

export function MonitorMcpDetailDialog(props: Props): React.ReactNode {
  const { task } = props;
  const setAppState = useSetAppState();
  const { columns } = useTerminalSize();
  const [outputPromise, setOutputPromise] = useState(() => readOutputTail(task.id));
  const deferredOutput = useDeferredValue(outputPromise);
  const wasRunning = useRef(task.status === 'running');
  useEffect(() => {
    pinTerminalTask(task.id, setAppState);
    return () => releaseTerminalTask(task.id, setAppState);
  }, [task.id, setAppState]);
  useEffect(() => {
    if (task.status !== 'running') {
      // One last read when it ends under the reader, so the tail shows what
      // it finished with; a task opened already finished was read on mount.
      if (wasRunning.current) setOutputPromise(readOutputTail(task.id));
      wasRunning.current = false;
      return;
    }
    wasRunning.current = true;
    const timer = setInterval(() => setOutputPromise(readOutputTail(task.id)), REFRESH_MS);
    return () => clearInterval(timer);
  }, [task.id, task.status]);
  return <MonitorMcpDetail {...props} outputPromise={deferredOutput} columns={columns} />;
}
