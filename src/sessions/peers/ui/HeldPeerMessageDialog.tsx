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
 * is the default and what Esc does.
 */
export function HeldPeerMessageDialog({ message, onDecision }: Props): React.ReactNode {
  const lines = message.body.split('\n')
  const shown = lines.slice(0, BODY_PREVIEW_LINES)
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
          {lines.length > shown.length && (
            <Text dimColor>… {lines.length - shown.length} more lines</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Select
            options={[
              { label: 'Deny — drop it and tell the sender it was declined', value: 'deny' },
              { label: 'Deliver it to Claude', value: 'deliver' },
            ]}
            onChange={value => onDecision(message.id, value === 'deliver' ? 'deliver' : 'deny')}
            onCancel={() => onDecision(message.id, 'deny')}
          />
        </Box>
      </Box>
    </PermissionDialog>
  )
}
