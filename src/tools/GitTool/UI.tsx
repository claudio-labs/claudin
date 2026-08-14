import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { ShellElapsedTime } from 'src/components/shell/ShellElapsedTime.js'
import { Box, Text } from 'src/ink.js'
import { oneLineCommand } from './display.js'
import type { Input, Output } from './GitTool.js'
import type { GitProgress } from './types.js'

export function userFacingName(): string {
  return 'Git'
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const commands = input.commands ?? []
  if (commands.length === 0) return ''
  // A `-m "…"` argument can carry newlines; the header is one line.
  const shown = commands.map(c => oneLineCommand(c))
  if (shown.length === 1) return shown[0]
  // ' · ' rather than '; ' or ' && ': the batch is a list, and a shell operator
  // in the header would misrepresent what ran.
  if (verbose) return shown.join(' · ')
  return `${shown[0]} · +${shown.length - 1} more`
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

/**
 * Structural, rather than the framework's `ProgressMessage<GitProgress>`:
 * `src/types/message.js` does not exist in this fork (it is stubbed at bundle
 * time), so importing it would add one more unresolved module for a type we
 * read one field of.
 */
type GitProgressMessage = { data?: GitProgress }

/**
 * The live line, replaced by the result the moment the batch finishes.
 *
 * Most git commands are done before this renders anything — `ShellElapsedTime`
 * shows nothing under a second. It exists for the ones that are not: a watch
 * runs for minutes, and with a frozen block that is indistinguishable from a
 * hang, which is the same distinction the stall report makes afterwards.
 *
 * The clock is `ShellElapsedTime` rather than the reported `elapsedMs` so it
 * ticks every second instead of once per poll, and keeps moving if the poller
 * goes quiet.
 */
export function renderToolUseProgressMessage(
  progressMessagesForMessage: GitProgressMessage[],
): React.ReactNode {
  const data = progressMessagesForMessage.at(-1)?.data
  if (!data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Running… </Text>
        <ShellElapsedTime />
      </MessageResponse>
    )
  }
  // The position only earns its space in a real batch.
  const position = data.total > 1 ? `${data.index}/${data.total} · ` : ''
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="truncate-end">
        {`${position}${oneLineCommand(data.command)} `}
      </Text>
      <ShellElapsedTime elapsedTimeSeconds={Math.floor(data.elapsedMs / 1000)} />
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
): React.ReactNode {
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {output.outcomes.map(outcome => {
          // A stalled watch exits non-zero without having failed, so it must
          // not wear the ✗ — the row would report a broken command.
          const ok = outcome.exitCode === 0
          return (
            <Text key={outcome.command} dimColor wrap="truncate-end">
              <Text color={outcome.stall ? 'warning' : ok ? 'success' : 'error'}>
                {outcome.stall ? '…' : ok ? '✓' : '✗'}
              </Text>{' '}
              {oneLineCommand(outcome.command)}
            </Text>
          )
        })}
        {output.notRun.map(command => (
          <Text key={command} dimColor wrap="truncate-end">
            ⊘ {oneLineCommand(command)}
          </Text>
        ))}
        {output.runError ? <Text color="error">{output.runError}</Text> : null}
      </Box>
    </MessageResponse>
  )
}
