// Footer rendered in transcript mode.
//
// Extracted from src/screens/REPL.tsx (Etapa 1, ROADMAP 11e). Must be
// rendered inside <KeybindingSetup> to read keybinding context.

import figures from 'figures'
import * as React from 'react'
import { Box, Text } from 'src/ink.js'
import { useShortcutDisplay } from 'src/keybindings/useShortcutDisplay.js'

export type TranscriptSearchBadge = {
  current: number
  count: number
}

export type TranscriptModeFooterProps = {
  showAllInTranscript: boolean
  virtualScroll: boolean
  searchBadge?: TranscriptSearchBadge
  /** When true (dump mode) the "show all" toggle hint is hidden. */
  suppressShowAll?: boolean
  status?: string
}

export function TranscriptModeFooter({
  showAllInTranscript,
  virtualScroll,
  searchBadge,
  suppressShowAll = false,
  status,
}: TranscriptModeFooterProps): React.ReactNode {
  const toggleShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  const showAllShortcut = useShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e')
  const trailingHint = searchBadge
    ? ' \u00B7 n/N to navigate'
    : virtualScroll
      ? ` \u00B7 ${figures.arrowUp}${figures.arrowDown} scroll \u00B7 home/end top/bottom`
      : suppressShowAll
        ? ''
        : ` \u00B7 ${showAllShortcut} to ${showAllInTranscript ? 'collapse' : 'show all'}`
  return (
    <Box
      noSelect
      alignItems="center"
      alignSelf="center"
      borderTopDimColor
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      marginTop={1}
      paddingLeft={2}
      width="100%"
    >
      <Text dimColor>Showing detailed transcript · {toggleShortcut} to toggle{trailingHint}</Text>
      {status ? (
        <>
          <Box flexGrow={1} />
          <Text>{status} </Text>
        </>
      ) : searchBadge ? (
        <>
          <Box flexGrow={1} />
          <Text dimColor>
            {searchBadge.current}/{searchBadge.count}
            {'  '}
          </Text>
        </>
      ) : null}
    </Box>
  )
}
