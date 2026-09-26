import React from 'react'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import type { HeldPeerMessage } from 'src/sessions/peers/heldMessages.js'
import { Select } from 'src/terminal/custom-select/select.js'
import { Box, Text } from 'src/terminal/ink.js'

const BODY_PREVIEW_LINES = 12

type Props = {
  message: HeldPeerMessage
  onDecision: (id: string, decision: 'deliver' | 'deny') => void
}

/**
 * A message another session sent that policy held for this session's user:
 * who sent it, why it was held, and exactly what Claude would read. Denying
 * is the default and what Esc does. A long body opens on its first lines, with
 * an option to show the rest before deciding.
 */
export function HeldPeerMessageDialog({ message, onDecision }: Props): React.ReactNode {
  const [expanded, setExpanded] = React.useState(false)
  const lines = message.body.split('\n')
  const hidden = expanded ? 0 : Math.max(0, lines.length - BODY_PREVIEW_LINES)
  const shown = hidden > 0 ? lines.slice(0, BODY_PREVIEW_LINES) : lines
  const from = message.sender.agent
    ? `${message.sender.name}, from its agent ${message.sender.agent}`
    : message.sender.name
  return (
    <PermissionDialog title="Held message from another session">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          <Text dimColor>From: </Text>
          {from}
        </Text>
        <Text>
          <Text dimColor>Held because </Text>
          {message.reason}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Message — this is what Claude would read:</Text>
          {shown.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
          {hidden > 0 && <Text dimColor>… {hidden} more lines — show them before you deliver it</Text>}
        </Box>
        <Box marginTop={1}>
          <Select
            options={[
              { label: 'Deny — drop it and tell the sender it was declined', value: 'deny' },
              ...(hidden > 0 ? [{ label: `Show all ${lines.length} lines`, value: 'expand' }] : []),
              { label: 'Deliver it to Claude', value: 'deliver' },
            ]}
            onChange={value => {
              if (value === 'expand') setExpanded(true)
              else onDecision(message.id, value === 'deliver' ? 'deliver' : 'deny')
            }}
            onCancel={() => onDecision(message.id, 'deny')}
          />
        </Box>
      </Box>
    </PermissionDialog>
  )
}
