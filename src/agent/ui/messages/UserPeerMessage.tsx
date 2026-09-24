import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import figures from 'figures'
import React from 'react'
import { describeInterAgentMessage } from 'src/agent/messages/interAgentMessages.js'
import { UserPromptMessage } from 'src/agent/ui/messages/UserPromptMessage.js'
import { Ansi, Box, Text } from 'src/terminal/ink.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
  isTranscriptMode?: boolean
}

/**
 * A message another agent sent this conversation through SendMessage. The
 * row names the sender and shows the first line — the line the sender was
 * told to make self-contained; the transcript view (ctrl+o) shows the rest,
 * the way a teammate message does.
 */
export function UserPeerMessage({
  addMargin,
  param,
  isTranscriptMode,
}: Props): React.ReactNode {
  const view = describeInterAgentMessage(param.text)
  if (!view) {
    return <UserPromptMessage addMargin={addMargin} param={param} />
  }
  const [headline = '', ...rest] = view.body.trim().split('\n')
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="cyan_FOR_SUBAGENTS_ONLY">{`@${view.sender}${figures.pointer}`}</Text>
        <Text> {headline}</Text>
        <Text dimColor>{` · ${view.relation}`}</Text>
      </Text>
      {isTranscriptMode && rest.length > 0 && (
        <Box paddingLeft={2}>
          <Text>
            <Ansi>{rest.join('\n')}</Ansi>
          </Text>
        </Box>
      )}
    </Box>
  )
}
