/**
 * Persistent footer row shown while a /goal stopping condition is active.
 * Displays the condition, blocked-stop iteration count, elapsed time, tokens
 * used since the goal was set, the judge's last check reason, and the
 * /goal clear hint. Renders nothing when no goal is active.
 */
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import { formatDuration } from '../utils/format.js'
import { getSessionTokenCount } from '../utils/goal/goal.js'

export function GoalStatusIndicator(): React.ReactNode {
  const activeGoal = useAppState((s: AppState) => s.activeGoal)
  if (!activeGoal) {
    return null
  }

  const elapsed = formatDuration(Date.now() - activeGoal.setAt, {
    mostSignificantOnly: true,
  })
  const tokensUsed = Math.max(
    0,
    getSessionTokenCount() - activeGoal.tokensAtStart,
  )
  const iterationLabel =
    activeGoal.iterations === 1 ? 'iteration' : 'iterations'

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor wrap="truncate">
        ◎ Goal active: {activeGoal.condition} · {activeGoal.iterations}{' '}
        {iterationLabel} · {elapsed} · {tokensUsed.toLocaleString()} tokens ·
        /goal clear to stop early
      </Text>
      {activeGoal.lastCheckReason ? (
        <Text dimColor wrap="truncate">
          {'  '}Last check: {activeGoal.lastCheckReason}
        </Text>
      ) : null}
    </Box>
  )
}
