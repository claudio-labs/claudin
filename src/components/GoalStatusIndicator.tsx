/**
 * Persistent footer row shown while a /goal stopping condition is active.
 * Displays the condition, blocked-stop iteration count, elapsed time, the
 * current context-window token total (same accounting as the footer `ctx`
 * pill and the Agents panel), the judge's last check reason, and the
 * /goal clear hint. Renders nothing when no goal is active.
 */
import * as React from 'react'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { Box, Text } from 'src/ink.js'
import { stringWidth } from 'src/ink/stringWidth.js'
import { useAppState } from 'src/state/AppState.js'
import type { AppState } from 'src/state/AppStateStore.js'
import type { Message } from 'src/types/message.js'
import { formatDuration } from 'src/shared/text/format.js'
import { getGoalTokenCount } from 'src/services/goal/goal.js'
import { truncateToWidth } from 'src/shared/text/truncate.js'

// Collapse newlines/runs of whitespace so a multi-line condition stays on one
// footer row instead of breaking the layout.
const WHITESPACE_RE = /\s+/g
// Floor so a long suffix on a narrow terminal still shows a usable slice of the
// condition (the outer wrap="truncate" clips the overflow after that).
const MIN_CONDITION_WIDTH = 16

export function GoalStatusIndicator({
  messages,
}: { messages?: Message[] } = {}): React.ReactNode {
  const { columns } = useTerminalSize()
  const activeGoal = useAppState((s: AppState) => s.activeGoal)
  if (!activeGoal) {
    return null
  }

  const elapsed = formatDuration(Date.now() - activeGoal.setAt, {
    mostSignificantOnly: true,
  })
  const tokensUsed = getGoalTokenCount(messages ?? [])
  const iterationLabel =
    activeGoal.iterations === 1 ? 'iteration' : 'iterations'

  // Mirror the Agents rows (CoordinatorAgentStatus): reserve the fixed prefix +
  // suffix width, then truncate the condition to whatever's left so the
  // iteration/elapsed/token metrics and the /goal clear hint stay visible
  // regardless of how long the condition is.
  const prefix = '◎ Goal active: '
  const suffix = ` · ${activeGoal.iterations} ${iterationLabel} · ${elapsed} · ${tokensUsed.toLocaleString()} tokens · /goal clear to stop early`
  // paddingX={2} on the Box → 2 columns of padding on each side.
  const available = Math.max(
    MIN_CONDITION_WIDTH,
    columns - 4 - stringWidth(prefix) - stringWidth(suffix),
  )
  const condition = truncateToWidth(
    activeGoal.condition.replace(WHITESPACE_RE, ' ').trim(),
    available,
  )

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor wrap="truncate">
        {prefix}
        {condition}
        {suffix}
      </Text>
      {activeGoal.lastCheckReason ? (
        <Text dimColor wrap="truncate">
          {'  '}Last check: {activeGoal.lastCheckReason}
        </Text>
      ) : null}
    </Box>
  )
}
