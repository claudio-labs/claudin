/**
 * FooterTaskSummary — the footer's task area in one line.
 *
 * Renders `  (2/1)  󱆃 (2)  󰍹 (1)`: one Nerd Font icon per non-empty group,
 * with its count. It is a permanent header, present in BOTH states — collapsed
 * it is the only thing the footer paints, expanded the agent panel and the
 * task tree render underneath it. That is what makes Enter a plain toggle,
 * matching how the `Shells (N)` headers inside the tree already behave.
 *
 * Collapsed is the default (AppState.footerTasksCollapsed), because the
 * expanded form holds 5+ terminal rows permanently and in fullscreen every one
 * of them is taken from the transcript ScrollBox.
 */

import figures from 'figures'
import * as React from 'react'
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js'
import { Box, Text } from 'src/terminal/ink.js'
import { useAppState, useSetAppState } from 'src/terminal/state/AppState.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getFooterGroupSegments } from 'src/agent/ui/tasks/footerGroupIcons.js'
import { getFooterPanelLayout } from 'src/agent/ui/tasks/footerTaskGeometry.js'
import {
  buildFooterSummarySegments,
  formatSegmentCount,
  toggleFooterTasksCollapsed,
} from 'src/agent/ui/tasks/footerSummary.js'

export function FooterTaskSummary(): React.ReactNode {
  const tasks = useAppState((s: AppState) => s.tasks)
  const foregroundedTaskId = useAppState((s: AppState) => s.foregroundedTaskId)
  const collapsed = useAppState((s: AppState) => s.footerTasksCollapsed)
  // The summary owns one row of the unified footer cursor; its index comes from
  // getFooterPanelLayout rather than a hardcoded 0, so the whole footer keeps
  // deriving its geometry in one place.
  const coordinatorTaskIndex = useAppState((s: AppState) => s.coordinatorTaskIndex)
  const tasksFocused = useAppState((s: AppState) => s.footerSelection === 'tasks')
  const summaryIndex = useAppState((s: AppState) => getFooterPanelLayout(s.tasks).summaryIndex)
  const setAppState = useSetAppState()
  const { columns } = useTerminalSize()
  const [hover, setHover] = React.useState(false)

  // getFooterGroupSegments reads env, so memoize it away from the render path.
  const segmentText = React.useMemo(() => getFooterGroupSegments(), [])
  const segments = React.useMemo(
    () => buildFooterSummarySegments(tasks, foregroundedTaskId),
    [tasks, foregroundedTaskId],
  )

  if (segments.length === 0) return null

  const isSelected = tasksFocused && coordinatorTaskIndex === summaryIndex
  const highlighted = isSelected || hover
  // 2-space prefix so the pointer column lines up with `● main` below
  // (CoordinatorTaskPanel renders at paddingX=0 with the same prefix).
  const prefix = highlighted ? `${figures.pointer} ` : '  '
  // Same chevron the tree's own group headers use (BackgroundTaskGroupTree),
  // for the same reason: it is the one mark in this footer that means "Enter
  // folds this". Without it the summary reads as a static status line, and on
  // a terminal with no Nerd Font it is also what tells the digest apart from
  // the `Shells (N)` header it expands into.
  const chevron = collapsed ? figures.triangleRight : figures.triangleDown
  // No inline "enter to expand" hint: whenever the byline shows its hint it
  // already prints the verb for the row the cursor is on (cursorRowKind ===
  // 'summary' in PromptInputFooterLeftSide), and saying it twice on adjacent
  // lines reads as two different affordances.

  // ONE <Text> for the whole line, not sibling <Text>s in a row Box: siblings
  // become independent flex columns that wrap separately (ink-tui.md §10), and
  // with the Nerd-Font-free labels six groups run past 70 columns. Wrapping
  // here would grow the footer by a row — the exact cost this line exists to
  // avoid, and in fullscreen that row comes out of the transcript ScrollBox.
  // Nested <Text> still carries the per-segment color.
  const line = (
    <Box width={columns}>
      <Text wrap="truncate">
        <Text dimColor>{prefix}{chevron} </Text>
        {segments.map((segment, i) => (
          <React.Fragment key={segment.key}>
            {i > 0 && <Text> </Text>}
            <Text color={segment.tone} bold={highlighted}>
              {segmentText[segment.key]}
            </Text>
            <Text dimColor={!highlighted}> {formatSegmentCount(segment)}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  )

  return (
    <Box
      onClick={() => toggleFooterTasksCollapsed(setAppState)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {line}
    </Box>
  )
}
