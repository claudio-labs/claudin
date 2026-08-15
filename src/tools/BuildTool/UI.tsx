import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { ShellElapsedTime } from 'src/components/shell/ShellElapsedTime.js'
import { Text } from 'src/ink.js'
import { formatDuration } from 'src/tools/BuildTool/budget.js'
import type { Input, Output } from 'src/tools/BuildTool/BuildTool.js'
import { resolveBuildCommand } from 'src/tools/BuildTool/BuildTool.js'
import type { BuildProgress } from 'src/tools/BuildTool/types.js'

export function userFacingName(): string {
  return 'Build'
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  // A build in another directory shows it, because `Build(make all)` on its own
  // would be indistinguishable from the same build in the project root.
  const where = input.directory ? ` in ${input.directory}` : ''
  if (input.command) return `${input.command}${where}`
  // Surface the auto-detected command so the user sees what will run, mirroring
  // Bash showing its command in the header.
  const resolved = resolveBuildCommand(input)
  if (resolved) return `${resolved.command}${where}`
  const parts: string[] = []
  if (input.path) parts.push(Array.isArray(input.path) ? input.path.join(', ') : input.path)
  if (input.system) parts.push(`(${input.system})`)
  return parts.length > 0 ? parts.join(' ') : verbose ? 'auto-detect build system' : ''
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

/**
 * Structural, rather than the framework's `ProgressMessage<BuildProgress>`:
 * `src/types/message.js` does not exist in this fork (it is stubbed at bundle
 * time, like `types/tools.js`), so importing it would add one more unresolved
 * module to the backlog for a type we only read one field of.
 */
type BuildProgressMessage = { data?: BuildProgress }

/**
 * The live line, replaced by the result the moment the build finishes.
 *
 * A build is the one tool call that can legitimately take minutes, and with
 * nothing on screen it is indistinguishable from a hang — which is exactly the
 * distinction the stall report exists to make. Showing the phase costs nothing:
 * progress messages are dropped before the request is serialized
 * (`utils/messages/normalize.ts:965`), so none of this reaches the model.
 *
 * The clock is `ShellElapsedTime` rather than the reported `elapsedMs` so it
 * ticks every second instead of once per poll, and keeps moving if the poller
 * goes quiet.
 */
export function renderToolUseProgressMessage(
  progressMessagesForMessage: BuildProgressMessage[],
): React.ReactNode {
  const data = progressMessagesForMessage.at(-1)?.data
  if (!data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Building… </Text>
        <ShellElapsedTime />
      </MessageResponse>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="truncate-end">
        {data.label ? `${data.system} · ${data.label} ` : `Building ${data.system}… `}
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

  const ok = output.exitCode === 0 && !output.stall
  const took = formatDuration(output.durationMs)
  const warnings =
    output.warnings > 0 ? `${output.warnings} warning${output.warnings === 1 ? '' : 's'}` : null
  // "built" would be a claim about compilation, and this tool runs whatever
  // command it is given — `make lint` produces no artifact and built nothing.
  // A verdict ("succeeded"/"failed") is true of every command it can run, and
  // it makes the two arms symmetric: the failing line used to report only
  // counts, never that the build had failed at all.
  const summary = output.stall
    ? `stopped after ${formatDuration(output.stall.ranMs)}`
    : output.degraded
      ? `could not parse output (~${output.errors} errors)`
      : output.upToDate
        ? 'up to date, nothing rebuilt'
        : ok
          ? [`build succeeded${took ? ` in ${took}` : ''}`, warnings].filter(Boolean).join(' · ')
          : [
              'build failed',
              [
                output.errors > 0 ? `${output.errors} error${output.errors === 1 ? '' : 's'}` : null,
                warnings,
              ]
                .filter(Boolean)
                .join(', '),
            ]
              .filter(Boolean)
              .join(' · ')

  // No command echo: `renderToolUseMessage` resolves the command the same way
  // this result did, so the header above already shows it verbatim — quiet
  // flags included — and repeating it here only costs a line.
  return (
    <MessageResponse>
      <Text color={ok ? 'success' : 'error'}>
        {ok ? '✓' : '✗'} {summary}
      </Text>
    </MessageResponse>
  )
}
