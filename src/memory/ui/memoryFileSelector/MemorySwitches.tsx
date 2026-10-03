import React from 'react'

import type { PickerFocus, SwitchKey } from 'src/memory/ui/memoryFileSelector/focus.js'
import { ListItem } from 'src/terminal/design-system/ListItem.js'
import { Box, Text } from 'src/terminal/ink.js'
import { useKeybindings } from 'src/terminal/keybindings/useKeybinding.js'

export type SwitchView = {
  key: SwitchKey
  label: string
  on: boolean
  /** Dimmed text after `on`/`off`, already prefixed with its ` · `. */
  detail: string
}

type MemorySwitchesProps = {
  switches: readonly SwitchView[]
  focus: PickerFocus
  onMove: (direction: 'up' | 'down') => void
  onToggle: (key: SwitchKey) => void
}

/** The `Auto-memory` and `Auto-dream` lines. They take the keys only while one of them is focused. */
export function MemorySwitches({ switches, focus, onMove, onToggle }: MemorySwitchesProps): React.ReactNode {
  useKeybindings(
    {
      'confirm:previous': () => onMove('up'),
      'confirm:next': () => onMove('down'),
      'confirm:yes': () => {
        if (focus !== 'list') onToggle(focus)
      },
    },
    { context: 'Confirmation', isActive: focus !== 'list' },
  )

  return (
    <Box flexDirection="column">
      {switches.map(view => (
        <ListItem key={view.key} isFocused={focus === view.key}>
          <Text>
            {view.label}: {view.on ? 'on' : 'off'}
            <Text dimColor>{view.detail}</Text>
          </Text>
        </ListItem>
      ))}
    </Box>
  )
}
