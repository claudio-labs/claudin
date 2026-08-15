import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { SubAgentProvider } from 'src/terminal/CtrlOToExpand.js';
import { FallbackToolUseErrorMessage } from 'src/agent/ui/FallbackToolUseErrorMessage.js';
import { FallbackToolUseRejectedMessage } from 'src/agent/ui/FallbackToolUseRejectedMessage.js';
import type { z } from 'zod/v4';
import type { Command } from 'src/commands/commands.js';
import { Byline } from 'src/terminal/design-system/Byline.js';
import { Message as MessageComponent } from 'src/agent/ui/Message.js';
import { MessageResponse } from 'src/agent/ui/MessageResponse.js';
import { Box, Text } from 'src/terminal/ink.js';
import type { Tools } from 'src/tools/Tool.js';
import type { ProgressMessage } from 'src/shared/types/message.js';
import { buildSubagentLookups, EMPTY_LOOKUPS } from 'src/agent/messages/messages.js';
import { plural } from 'src/shared/text/stringUtils.js';
import type { inputSchema, Output, Progress } from 'src/tools/SkillTool/SkillTool.js';
type Input = z.infer<ReturnType<typeof inputSchema>>;
const MAX_PROGRESS_MESSAGES_TO_SHOW = 3;
const INITIALIZING_TEXT = 'Initializing…';
export function renderToolResultMessage(output: Output): React.ReactNode {
  // Handle forked skill result
  if ('status' in output && output.status === 'forked') {
    return <MessageResponse height={1}>
        <Text>
          <Byline>{['Done']}</Byline>
        </Text>
      </MessageResponse>;
  }
  const parts: string[] = ['Successfully loaded skill'];

  // Show tools count (only for inline skills)
  if ('allowedTools' in output && output.allowedTools && output.allowedTools.length > 0) {
    const count = output.allowedTools.length;
    parts.push(`${count} ${plural(count, 'tool')} allowed`);
  }

  // Show model if non-default (only for inline skills)
  if ('model' in output && output.model) {
    parts.push(output.model);
  }
  return <MessageResponse height={1}>
      <Text>
        <Byline>{parts}</Byline>
      </Text>
    </MessageResponse>;
}
export function renderToolUseMessage({
  skill
}: Partial<Input>, {
  commands
}: {
  commands?: Command[];
}): React.ReactNode {
  if (!skill) {
    return null;
  }
  // Only legacy /commands_DEPRECATED entries need the command lookup so we can
  // preserve the slash-prefixed display. Plugin skills already carry the
  // invoked skill name in `skill`, so transcript/history rendering does not
  // need plugin command metadata.
  const command = commands?.find(c => c.name === skill);
  const displayName = command?.loadedFrom === 'commands_DEPRECATED' ? `/${skill}` : skill;
  return displayName;
}
export function renderToolUseProgressMessage(progressMessages: ProgressMessage<Progress>[], {
  tools,
  verbose
}: {
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  if (!progressMessages.length) {
    return <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>;
  }

  // Take only the last few messages for display in non-verbose mode
  const displayedMessages = verbose ? progressMessages : progressMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW);
  const hiddenCount = progressMessages.length - displayedMessages.length;
  const {
    inProgressToolUseIDs
  } = buildSubagentLookups(progressMessages.map(pm => pm.data) as Parameters<typeof buildSubagentLookups>[0]);
  return <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {displayedMessages.map(progressMessage => <Box key={progressMessage.uuid} height={1} overflow="hidden">
              <MessageComponent message={progressMessage.data.message} lookups={EMPTY_LOOKUPS} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} style="condensed" isTranscriptMode={false} isStatic={true} />
            </Box>)}
        </SubAgentProvider>
        {hiddenCount > 0 && <Text dimColor>
            +{hiddenCount} more tool {plural(hiddenCount, 'use')}
          </Text>}
      </Box>
    </MessageResponse>;
}
export function renderToolUseRejectedMessage(_input: Input, {
  progressMessagesForMessage,
  tools,
  verbose
}: {
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose
    })}
      <FallbackToolUseRejectedMessage />
    </>;
}
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  progressMessagesForMessage,
  tools,
  verbose
}: {
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose
    })}
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </>;
}
