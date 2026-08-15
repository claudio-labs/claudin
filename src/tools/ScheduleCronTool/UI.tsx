import React from 'react';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { Text } from 'src/ink.js';
import { truncate } from 'src/shared/text/format.js';
import type { CreateOutput } from 'src/tools/ScheduleCronTool/CronCreateTool.js';
import type { DeleteOutput } from 'src/tools/ScheduleCronTool/CronDeleteTool.js';
import type { ListOutput } from 'src/tools/ScheduleCronTool/CronListTool.js';

// --- CronCreate -------------------------------------------------------------

export function renderCreateToolUseMessage(input: Partial<{
  cron: string;
  prompt: string;
}>): React.ReactNode {
  return `${input.cron ?? ''}${input.prompt ? `: ${truncate(input.prompt, 60, true)}` : ''}`;
}
export function renderCreateResultMessage(output: CreateOutput): React.ReactNode {
  return <MessageResponse>
      <Text>
        Scheduled <Text bold>{output.id}</Text>{' '}
        <Text dimColor>({output.humanSchedule})</Text>
      </Text>
    </MessageResponse>;
}

// --- CronDelete -------------------------------------------------------------

export function renderDeleteToolUseMessage(input: Partial<{
  id: string;
}>): React.ReactNode {
  return input.id ?? '';
}
export function renderDeleteResultMessage(output: DeleteOutput): React.ReactNode {
  return <MessageResponse>
      <Text>
        Cancelled <Text bold>{output.id}</Text>
      </Text>
    </MessageResponse>;
}

// --- CronList ---------------------------------------------------------------

export function renderListToolUseMessage(): React.ReactNode {
  return '';
}
export function renderListResultMessage(output: ListOutput): React.ReactNode {
  if (output.jobs.length === 0) {
    return <MessageResponse>
        <Text dimColor>No scheduled jobs</Text>
      </MessageResponse>;
  }
  return <MessageResponse>
      {output.jobs.map(j => <Text key={j.id}>
          <Text bold>{j.id}</Text> <Text dimColor>{j.humanSchedule}</Text>
        </Text>)}
    </MessageResponse>;
}

// --- Shared -----------------------------------------------------------------
