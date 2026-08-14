import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { ShellElapsedTime } from 'src/components/shell/ShellElapsedTime.js'
import { Box, Text } from 'src/ink.js'
import type { Input, Output } from './TypecheckTool.js'
import { resolveCheckCommand } from './TypecheckTool.js'
import type { CheckProgress } from './types.js'

/**
 * Display label only — the wire name stays `Typecheck` (see prompt.ts), which is
 * what the description, the alias and the Bash refusal message address. `Build`
 * sits beside this tool now, and `SourceCheck` is the honest label for the one
 * that reads the source without producing anything: it also drives `phpstan`,
 * `psalm` and `dart analyze`, none of which are type checkers. Same split as
 * `RunTests`, which renders as `Test` (RunTestsTool/UI.tsx).
 */
export function userFacingName(): string {
  return 'SourceCheck'
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

/**
 * Structural, rather than the framework's `ProgressMessage<CheckProgress>`:
 * `src/types/message.js` does not exist in this fork (it is stubbed at bundle
 * time), so importing it would add one more unresolved module to the backlog
 * for a type we only read one field of.
 */
type CheckProgressMessage = { data?: CheckProgress }

/**
 * The live line, replaced by the result the moment the check finishes.
 *
 * A whole-project check takes as long as a build, and with nothing on screen it
 * was indistinguishable from a hang — Bash shows a stopwatch for far shorter
 * commands. The clock is `ShellElapsedTime` rather than the reported
 * `elapsedMs` so it ticks every second instead of once per poll, and keeps
 * moving if the poller goes quiet.
 */
export function renderToolUseProgressMessage(
  progressMessagesForMessage: CheckProgressMessage[],
): React.ReactNode {
  const data = progressMessagesForMessage.at(-1)?.data
  if (!data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Checking… </Text>
        <ShellElapsedTime />
      </MessageResponse>
    )
  }
  const what =
    data.phase === 'baseline'
      ? `rebuilding baseline${data.label ? ` · ${data.label}` : ''}`
      : data.label
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="truncate-end">
        {what ? `${data.checker} · ${what} ` : `Checking with ${data.checker}… `}
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
