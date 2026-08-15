import React from 'react';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { Text } from 'src/ink.js';
import { truncate } from 'src/utils/text/format.js';
import type { WakeupOutput } from 'src/tools/ScheduleWakeupTool/ScheduleWakeupTool.js';

export function renderWakeupToolUseMessage(input: Partial<{
  delaySeconds: number;
  reason: string;
  cancel: boolean;
}>): React.ReactNode {
  if (input.cancel) return 'cancel';
  const delay = typeof input.delaySeconds === 'number' ? `${input.delaySeconds}s` : '';
  return `${delay}${input.reason ? `: ${truncate(input.reason, 60, true)}` : ''}`;
}

export function renderWakeupResultMessage(output: WakeupOutput): React.ReactNode {
  if (output.action === 'cancelled') {
    return <MessageResponse>
        <Text>
          {output.hadPending ? 'Cancelled pending wakeup' : 'No wakeup pending'}
        </Text>
      </MessageResponse>;
  }
  return <MessageResponse>
      <Text>
        Wakeup at <Text bold>{output.fireAt}</Text>{' '}
        <Text dimColor>({output.reason})</Text>
      </Text>
    </MessageResponse>;
}
