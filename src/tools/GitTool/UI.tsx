import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { Input, Output } from './GitTool.js'

export function userFacingName(): string {
  return 'Git'
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const commands = input.commands ?? []
  if (commands.length === 0) return ''
  if (commands.length === 1) return commands[0]
  // ' · ' rather than '; ' or ' && ': the batch is a list, and a shell operator
  // in the header would misrepresent what ran.
  if (verbose) return commands.join(' · ')
  return `${commands[0]} · +${commands.length - 1} more`
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
): React.ReactNode {
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {output.outcomes.map(outcome => (
          <Text key={outcome.command} dimColor wrap="truncate-end">
            <Text color={outcome.exitCode === 0 ? 'success' : 'error'}>
              {outcome.exitCode === 0 ? '✓' : '✗'}
            </Text>{' '}
            {outcome.command}
          </Text>
        ))}
        {output.notRun.map(command => (
          <Text key={command} dimColor wrap="truncate-end">
            ⊘ {command}
          </Text>
        ))}
        {output.runError ? <Text color="error">{output.runError}</Text> : null}
      </Box>
    </MessageResponse>
  )
}
