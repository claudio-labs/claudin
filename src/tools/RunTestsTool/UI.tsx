import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { ShellElapsedTime } from 'src/components/shell/ShellElapsedTime.js'
import { Box, Text } from 'src/terminal/ink.js'
import type { Input, Output } from 'src/tools/RunTestsTool/RunTestsTool.js'
import { resolveRunCommand } from 'src/tools/RunTestsTool/RunTestsTool.js'
import type { TestProgress } from 'src/tools/RunTestsTool/types.js'

export function userFacingName(): string {
  return 'Test'
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (input.command) return input.command
  // No explicit command: surface the auto-detected command so the user sees what
  // will run (mirrors Bash showing its command in the header).
  const resolved = resolveRunCommand(input)
  if (resolved) return resolved.command
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

/**
 * Structural, rather than the framework's `ProgressMessage<TestProgress>`:
 * `src/types/message.js` does not exist in this fork (it is stubbed at bundle
 * time), so importing it would add one more unresolved module to the backlog
 * for a type we only read one field of.
 */
type TestProgressMessage = { data?: TestProgress }

/**
 * The live line, replaced by the result the moment the suite finishes.
 *
 * A full suite is one of the longest tool calls there is, and with nothing on
 * screen it was indistinguishable from a hang — Bash shows a stopwatch for far
 * shorter commands. The clock is `ShellElapsedTime` rather than the reported
 * `elapsedMs` so it ticks every second instead of once per poll, and keeps
 * moving if the poller goes quiet.
 */
export function renderToolUseProgressMessage(
  progressMessagesForMessage: TestProgressMessage[],
): React.ReactNode {
  const data = progressMessagesForMessage.at(-1)?.data
  if (!data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Running tests… </Text>
        <ShellElapsedTime />
      </MessageResponse>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="truncate-end">
        {data.label ? `${data.framework} · ${data.label} ` : `Running ${data.framework}… `}
      </Text>
      <ShellElapsedTime elapsedTimeSeconds={Math.floor(data.elapsedMs / 1000)} />
    </MessageResponse>
  )
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
