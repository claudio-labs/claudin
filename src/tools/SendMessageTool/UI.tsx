import React from 'react';
import { MessageResponse } from 'src/agent/ui/MessageResponse.js';
import { Text } from 'src/terminal/ink.js';
import { jsonParse } from 'src/platform/slowOperations.js';
import type { Input, SendMessageToolOutput } from 'src/tools/SendMessageTool/SendMessageTool.js';
const LABEL_MAX_CHARS = 80;

// A `uds:` address is copied from a message's `from` — the socket path means
// nothing to a reader, and the result line names the session.
function recipientLabel(to: string): string {
  return to.startsWith('uds:') ? 'reply' : to;
}
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  if (input.message === undefined && input.notify_when_idle && input.to) {
    return `${recipientLabel(input.to)}: notify when idle`;
  }
  if (typeof input.message === 'string') {
    if (!input.to) {
      return null;
    }
    const label = input.summary?.trim() || input.message.trim().split('\n')[0] || '';
    if (!label) {
      return recipientLabel(input.to);
    }
    return `${recipientLabel(input.to)}: ${label.length > LABEL_MAX_CHARS ? `${label.slice(0, LABEL_MAX_CHARS - 1)}…` : label}`;
  }
  if (typeof input.message !== 'object' || input.message === null) {
    return null;
  }
  if (input.message.type === 'plan_approval_response') {
    return input.message.approve ? `approve plan from: ${input.to}` : `reject plan from: ${input.to}`;
  }
  return null;
}
export function renderToolResultMessage(content: SendMessageToolOutput | string, _progressMessages: unknown, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  const result: SendMessageToolOutput = typeof content === 'string' ? jsonParse(content) : content;
  if ('routing' in result && result.routing) {
    return null;
  }
  if ('request_id' in result && 'target' in result) {
    return null;
  }
  return <MessageResponse>
      <Text dimColor>{result.message}</Text>
    </MessageResponse>;
}
