import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { Input, Output } from './TypecheckTool.js'
import { resolveCheckCommand } from './TypecheckTool.js'

export function userFacingName(): string {
  return 'Typecheck'
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (input.command) return input.command
  // Surface the auto-detected command so the user sees what will run, mirroring
  // Bash showing its command in the header.
  const resolved = resolveCheckCommand(input)
  if (resolved) return resolved.command
  const parts: string[] = []
  if (input.path) parts.push(Array.isArray(input.path) ? input.path.join(', ') : input.path)
  if (input.checker) parts.push(`(${input.checker})`)
  return parts.length > 0 ? parts.join(' ') : verbose ? 'auto-detect type checker' : ''
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

  const ok = output.newCount === 0 && !output.degraded
  const summary = output.degraded
    ? `could not parse output (~${output.errors} errors)`
    : [
        `${output.newCount} new`,
        output.preExistingCount > 0 ? `${output.preExistingCount} pre-existing` : null,
        output.fixedCount > 0 ? `${output.fixedCount} fixed` : null,
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
