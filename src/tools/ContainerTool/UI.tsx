import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { FallbackToolUseErrorMessage } from 'src/agent/ui/FallbackToolUseErrorMessage.js'
import { MessageResponse } from 'src/agent/ui/MessageResponse.js'
import { ShellElapsedTime } from 'src/tools/BashTool/ui/ShellElapsedTime.js'
import { Box, Text } from 'src/terminal/ink.js'
import {
  formatContainerState,
  portSummary,
  shortContainerName,
} from 'src/containers/format.js'
import type {
  ContainerToolInput,
  ContainerToolOutput,
} from 'src/tools/ContainerTool/types.js'

/**
 * The progress payload is declared here because it is a TUI-only channel —
 * progress messages are dropped before the request is serialized, so it has no
 * model-facing counterpart. The input and output shapes ARE imported from
 * `types.ts` on purpose: a field renamed there and mirrored by hand here fails
 * silently, showing a blank cell in the TUI while the model-facing string stays
 * correct (the `outputSchema` trap in .claudin/rules/typescript-patterns.md).
 */
type ContainerProgress = {
  /** Live one-liner, e.g. `[4/9] RUN pip install -r requirements.txt`. */
  label: string
  elapsedMs?: number
}

type ContainerProgressMessage = { data?: ContainerProgress }

/** Evidence is raw docker output — keep the block short enough to stay a hint
 * rather than a second copy of the result the model already has. */
const MAX_EVIDENCE_LINES = 6

/** Rows past this are counted rather than listed; a scaled stack should not
 * take the screen. */
const MAX_ROWS = 10

export function userFacingName(): string {
  return 'Container'
}

/** Collapse a value to one line so a multi-line `exec` command cannot break the
 * single-row header. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * The one-line verdict above the detail. Derived here rather than carried on
 * the result: it is presentation, and the model already has the same facts in
 * the tool result's text.
 */
function summaryFor(output: ContainerToolOutput): string {
  if (output.build) {
    const b = output.build
    if (b.allCached) return 'up to date, nothing rebuilt'
    if (b.failure) return `build failed at step #${b.failure.stepIndex}`
    return `built · ${b.cachedCount} cached, ${b.rebuiltCount} rebuilt`
  }
  if (output.wait) {
    if (output.wait.impossible) return output.wait.impossible
    return output.wait.satisfied
      ? `${output.wait.observedState} after ${Math.round(output.wait.waitedMs / 1000)}s`
      : `still ${output.wait.observedState} after ${Math.round(output.wait.waitedMs / 1000)}s`
  }
  if (output.backgroundTaskId) return `running in the background (${output.backgroundTaskId})`
  if (output.rows) {
    const n = output.rows.length
    return n === 1 ? '1 container' : `${n} containers`
  }
  if (output.exitCode !== 0) return `${output.op} failed (exit ${output.exitCode})`
  return output.op
}

export function renderToolUseMessage(
  input: Partial<ContainerToolInput>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const op = input.op
  if (!op) return ''
  // Optional on purpose: `ps`, `df` and `images` address the whole project.
  const target = input.service ?? ''
  const parts = [op, target].filter(Boolean)
  // `exec` without its command reads as if it did nothing, so it is the one op
  // whose argument earns space in the header.
  if (input.command?.length && (verbose || op === 'exec' || op === 'run')) {
    parts.push(oneLine(input.command.join(' ')))
  }
  if (input.background) parts.push('(background)')
  return parts.join(' ')
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

/**
 * The live line, replaced by the result the moment the op finishes.
 *
 * Only a build produces one for long enough to matter, and it is exactly the
 * case that needs it: a cold Dockerfile runs for minutes, and a frozen block is
 * indistinguishable from a hang. Progress messages are dropped before the
 * request is serialized, so nothing here reaches the model.
 *
 * The clock is `ShellElapsedTime` rather than the reported `elapsedMs` so it
 * ticks every second instead of once per poll, and keeps moving if BuildKit
 * goes quiet mid-layer.
 */
export function renderToolUseProgressMessage(
  progressMessagesForMessage: ContainerProgressMessage[],
): React.ReactNode {
  const data = progressMessagesForMessage.at(-1)?.data
  if (!data?.label) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Running… </Text>
        <ShellElapsedTime />
      </MessageResponse>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="truncate-end">
        {`docker · ${oneLine(data.label)} `}
      </Text>
      <ShellElapsedTime
        elapsedTimeSeconds={data.elapsedMs === undefined ? undefined : Math.floor(data.elapsedMs / 1000)}
      />
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: ContainerToolOutput,
  _progressMessages: unknown[],
): React.ReactNode {
  const ok = output.exitCode === 0
  const rows = (output.rows ?? []).slice(0, MAX_ROWS)
  const elidedRows = (output.rows?.length ?? 0) - rows.length
  const diagnosis = output.diagnosis ?? null
  // Evidence is a block of raw docker lines; the summary above it is the
  // verdict. Trimming keeps a 400-line traceback from taking the screen.
  const evidenceLines = diagnosis?.evidence
    ? diagnosis.evidence.split('\n').filter(line => line.trim() !== '').slice(0, MAX_EVIDENCE_LINES)
    : []
  const elidedEvidence = diagnosis?.evidence
    ? diagnosis.evidence.split('\n').filter(line => line.trim() !== '').length - evidenceLines.length
    : 0

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color={ok ? 'success' : 'error'}>
          {ok ? '✓' : '✗'} {summaryFor(output)}
        </Text>
        {rows.map(row => {
          // One `<Text>` per row on purpose: siblings in a row Box lay out as
          // independently wrapping columns, which interleaves the name and the
          // ports across lines at narrow widths (.claudin/rules/ink-tui.md §10).
          // A nested `<Text>` for colour composes with the parent's dimColor.
          const state = formatContainerState(row.container)
          const ports = portSummary(row.container)
          return (
            <Text key={row.container.id} dimColor wrap="truncate-end">
              {'  '}
              {shortContainerName(row.container)} ·{' '}
              <Text color={row.diagnosis ? 'error' : undefined}>{state}</Text>
              {ports ? ` · ${ports}` : ''}
              {row.diagnosis ? ` · ${row.diagnosis.summary}` : ''}
            </Text>
          )
        })}
        {elidedRows > 0 ? (
          <Text dimColor>{`  … ${elidedRows} more`}</Text>
        ) : null}
        {output.stall ? (
          // An observation, never a verdict: a long `RUN apt-get` is quiet for
          // legitimate reasons and this must not read as "it hung".
          <Text dimColor wrap="truncate-end">
            {`⎿ stopped after ${Math.round(output.stall.ranMs / 1000)}s, silent for ${Math.round(output.stall.silentMs / 1000)}s`}
          </Text>
        ) : null}
        {output.contextWarning ? (
          <Text dimColor wrap="truncate-end">{`⎿ ${output.contextWarning}`}</Text>
        ) : null}
        {diagnosis ? (
          <Text color="error" wrap="truncate-end">
            ⎿ {diagnosis.summary}
          </Text>
        ) : null}
        {evidenceLines.map((line, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <Text key={`evidence-${i}`} dimColor wrap="truncate-end">
            {'    '}
            {line}
          </Text>
        ))}
        {elidedEvidence > 0 ? (
          <Text dimColor>{`    … ${elidedEvidence} more line${elidedEvidence === 1 ? '' : 's'}`}</Text>
        ) : null}
      </Box>
    </MessageResponse>
  )
}
