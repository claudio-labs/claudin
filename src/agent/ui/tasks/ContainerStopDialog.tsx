// Confirmation in front of `docker stop`, raised by `x` on a footer container
// row.
//
// The other footer rows kill without asking, because the process being killed
// is one this session spawned. A container is not: it can be the user's
// database, and `startedByUs` is false whenever it was already running before
// the Container tool touched it. That distinction is the whole reason this
// dialog exists, so it is stated in the copy rather than left implicit.

import React, { useCallback } from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import { Dialog } from 'src/terminal/design-system/Dialog.js';
import { Select } from 'src/terminal/custom-select/select.js';
import { ContainerTask } from 'src/agent/tasks/ContainerTask/ContainerTask.js';
import { useSetAppState } from 'src/terminal/state/AppState.js';
import type { PendingContainerStop } from 'src/terminal/state/AppStateStore.js';

type Props = {
  pending: PendingContainerStop;
};

// Cancel is first so a blind Enter is the safe answer — the destructive option
// should never be the one a reflex selects.
const OPTIONS = [
  { label: 'Cancel', value: 'no' },
  { label: 'Stop it', value: 'yes' },
];

export function ContainerStopDialog({ pending }: Props): React.ReactNode {
  const setAppState = useSetAppState();

  const clear = useCallback(() => {
    setAppState(prev => ({ ...prev, pendingContainerStop: null }));
  }, [setAppState]);

  const handleSelect = useCallback(
    (value: string) => {
      // Clear first: `kill` awaits `docker stop`, and leaving the dialog up for
      // those seconds reads as a hang. The row does not disappear here either —
      // the next snapshot reports the container as exited, so the UI never
      // claims a stop docker refused.
      clear();
      if (value === 'yes') {
        void ContainerTask.kill(pending.taskId, setAppState);
      }
    },
    [clear, pending.taskId, setAppState],
  );

  return (
    <Dialog
      title={`Stop ${pending.name}?`}
      onCancel={clear}
      color="error"
    >
      <Box marginX={2} flexDirection="column">
        <Text dimColor>
          {pending.startedByUs
            ? 'Claudin started this container in this session.'
            : 'This container was not started by Claudin.'}
        </Text>
      </Box>
      <Select onChange={handleSelect} onCancel={clear} options={OPTIONS} />
    </Dialog>
  );
}
