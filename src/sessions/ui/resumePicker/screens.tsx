/**
 * The startup picker's own screens, around the session list it borrows.
 */
import React, { useEffect } from 'react'
import { Box, Text, useInput } from 'src/terminal/ink.js'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'

/** Rows the failure banner takes above the list: three lines and a gap. */
export const FAILURE_BANNER_ROWS = 4

/** How long the cross-project screen stays up before the process ends. */
const CROSS_PROJECT_EXIT_DELAY_MS = 100

export function FailureBanner({ message }: { message: string }): React.ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="error">Failed to resume conversation.</Text>
      <Text>{message}</Text>
      <Text dimColor>Choose a different conversation to continue.</Text>
    </Box>
  )
}

type NothingToResumeProps = {
  allProjects: boolean
  onToggleScope: () => void
  onInterrupt: () => void
}

/** No session to list. Ctrl+A still switches between this project and every project. */
export function NothingToResume({ allProjects, onToggleScope, onInterrupt }: NothingToResumeProps): React.ReactNode {
  useKeybinding('app:interrupt', onInterrupt, { context: 'Global' })
  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'a') onToggleScope()
  })
  const elsewhere = allProjects ? "this project's sessions" : 'sessions from all projects'
  return (
    <Box flexDirection="column">
      <Text>No conversations found to resume.</Text>
      <Text dimColor>Press Ctrl+C to exit and start a new conversation.</Text>
      <Text dimColor>Press Ctrl+A to show {elsewhere}.</Text>
    </Box>
  )
}

type ElsewhereProps = {
  command: string
  onShown: () => void
}

export function ResumeElsewhere({ command, onShown }: ElsewhereProps): React.ReactNode {
  useEffect(() => {
    const timer = setTimeout(onShown, CROSS_PROJECT_EXIT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [onShown])
  return (
    <Box flexDirection="column">
      <Text>This conversation is from a different directory.</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>To resume, run:</Text>
        <Text> {command}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>(Command copied to clipboard)</Text>
      </Box>
    </Box>
  )
}
