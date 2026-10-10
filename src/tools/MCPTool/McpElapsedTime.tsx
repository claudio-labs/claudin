import * as React from 'react'

import { useElapsedSeconds } from 'src/terminal/hooks/useElapsedTime.js'
import { Text } from 'src/terminal/ink.js'
import type { MCPProgress } from 'src/shared/types/tools.js'
import { formatDuration } from 'src/shared/text/format.js'

/**
 * How long a batch of MCP calls has to take before its time is worth showing.
 * Same bar as the shell's: below it most calls are done, and a counter would
 * only flicker — or, frozen, clutter every quick lookup.
 */
const MCP_ELAPSED_MIN_SECONDS = 2

export type McpCallTiming = {
  /** The last `mcp_progress` tick the call emitted. */
  tick: MCPProgress
  /** Still executing in the group that is running now. */
  running: boolean
}

export type McpBatchSpan = {
  /** When the first call of the batch started (epoch ms). */
  startedAt: number
  /** When the last one ended — only once every call has. */
  endedAt?: number
}

/**
 * The wall-clock span of a group's MCP calls, from the earliest start.
 *
 * Open while any call runs, so the clock never drops back to zero when serial
 * calls hand over. Closed once every call reported `completed` or `failed`;
 * a call that stopped without either (an interrupted turn) leaves no span.
 */
export function mcpBatchSpan(
  calls: readonly McpCallTiming[],
): McpBatchSpan | undefined {
  let startedAt: number | undefined
  for (const { tick } of calls) {
    if (tick.startedAt !== undefined) {
      startedAt = Math.min(startedAt ?? tick.startedAt, tick.startedAt)
    }
  }
  if (startedAt === undefined) {
    return undefined
  }
  if (calls.some(call => call.running)) {
    return { startedAt }
  }
  let endedAt = startedAt
  for (const { tick } of calls) {
    // Only `completed` and `failed` carry elapsedTimeMs.
    if (tick.startedAt === undefined || tick.elapsedTimeMs === undefined) {
      return undefined
    }
    endedAt = Math.max(endedAt, tick.startedAt + tick.elapsedTimeMs)
  }
  return { startedAt, endedAt }
}

/**
 * The ` · 12s` after "Calling context7 2 times" in the collapsed group header.
 *
 * Live while the batch runs, ticking on its own from the real start the
 * progress ticks carry, so a remount does not reset it. Frozen at the batch's
 * span once it ends, which is what "Called context7 2 times · 14s" keeps.
 */
export function McpGroupElapsedTime({
  startedAt,
  endedAt,
}: McpBatchSpan): React.ReactNode {
  const liveSeconds = useElapsedSeconds(startedAt, endedAt === undefined)
  const seconds =
    endedAt === undefined
      ? liveSeconds
      : Math.floor((endedAt - startedAt) / 1000)

  if (seconds < MCP_ELAPSED_MIN_SECONDS) {
    return null
  }

  return (
    <>
      {' · '}
      <Text bold>{formatDuration(seconds * 1000)}</Text>
    </>
  )
}
