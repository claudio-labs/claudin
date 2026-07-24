import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { Input, Output } from './RunTestsTool.js'

export function userFacingName(): string {
  return 'Test'
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (input.command) return input.command
  const parts: string[] = []
  if (input.path) parts.push(input.path)
  if (input.pattern) parts.push(`-t ${input.pattern}`)
  if (input.framework) parts.push(`(${input.framework})`)
  return parts.length > 0 ? parts.join(' ') : verbose ? 'auto-detect suite' : ''
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
  if (output.runError) {
    return (
      <MessageResponse>
        <Text color="error">{output.runError}</Text>
      </MessageResponse>
    )
  }
  const ok = output.failed === 0
  const summary = [
    `${output.passed} passed`,
    output.failed > 0 ? `${output.failed} failed` : null,
    output.skipped > 0 ? `${output.skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {output.command ? (
          <Text dimColor wrap="truncate-end">
            {output.command}
          </Text>
        ) : null}
        <Text color={ok ? 'success' : 'error'}>
          {ok ? '✓' : '✗'} {summary}
        </Text>
      </Box>
    </MessageResponse>
  )
}
