// Detail view for a navigation-map notice (RuleMapTask): which file was
// written and the counts it moved. The row itself is capped to three changes
// (summarizeDirCountChanges); this is where the rest are read — as many as the
// terminal has rows for, since a first map lists every directory it drew.
//
// The notice is listed for seconds, so the view pins it while it is open —
// otherwise its eviction would close the dialog under the reader.
//
// Hand-written, not React-Compiler output: there is no state worth memoizing.

import React, { useEffect } from 'react';
import type { RuleMapTaskState } from 'src/agent/tasks/RuleMapTask/RuleMapTask.js';
import { pinTerminalTask, releaseTerminalTask } from 'src/agent/tasks/framework.js';
import { ruleMapRowState } from 'src/agent/ui/tasks/ruleMapRowLabel.js';
import { formatDirCountChange } from 'src/memory/instructions/rulesMapSync.js';
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

/** Rows the dialog spends on its frame, title, subtitle and input guide. */
const DIALOG_CHROME_ROWS = 10;
/** Change lines shown however short the terminal is. */
const MIN_VISIBLE_CHANGES = 3;

type Props = {
  task: DeepImmutable<RuleMapTaskState>;
  onDone: () => void;
  onBack?: () => void;
};

export function RuleMapDetailDialog({ task, onDone, onBack }: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const { rows } = useTerminalSize();
  useEffect(() => {
    pinTerminalTask(task.id, setAppState);
    return () => releaseTerminalTask(task.id, setAppState);
  }, [task.id, setAppState]);
  useKeybindings({ 'confirm:yes': onDone }, { context: 'Confirmation' });
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      onDone();
    } else if (e.key === 'left' && onBack) {
      e.preventDefault();
      onBack();
    }
  };
  const inputGuide = (exitState: ExitState) => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline>
        {onBack && <KeyboardShortcutHint shortcut={'\u2190'} action="go back" />}
        <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
      </Byline>;
  const changes = task.result?.changes ?? [];
  const budget = Math.max(MIN_VISIBLE_CHANGES, rows - DIALOG_CHROME_ROWS);
  // A line for "… and N more" counts against the budget too.
  const shown = changes.length > budget ? changes.slice(0, budget - 1) : changes;
  const hidden = changes.length - shown.length;
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog title="Navigation map" subtitle={<Text dimColor>{task.result?.path ?? task.description}</Text>} onCancel={onDone} color="background" inputGuide={inputGuide}>
        <Box flexDirection="column">
          {shown.length > 0 ? shown.map(change => <Text key={change.path}>{formatDirCountChange(change)}</Text>) : <Text dimColor>{ruleMapRowState(task)}</Text>}
          {hidden > 0 && <Text dimColor>… and {hidden} more</Text>}
        </Box>
      </Dialog>
    </Box>;
}
