import React, { useRef } from 'react'
import { Box, Link, Text } from 'src/terminal/ink.js'
import { Select } from 'src/terminal/custom-select/index.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { recordAutoConsent } from 'src/permissions/ui/modeDialogs/consentSettings.js'

export const AUTO_MODE_DESCRIPTION =
  'Auto mode lets Claudin handle permission prompts automatically: it checks each tool call for risky actions and ' +
  'prompt injection before executing it. Calls Claudin identifies as safe are executed, while those it identifies as ' +
  'risky are blocked and Claudin may try a different approach. Best suited to long-running tasks. Sessions are ' +
  'slightly more expensive. Claudin can make mistakes that allow harmful commands to run, so only use in isolated ' +
  'environments. Shift+Tab to change mode.'

const SECURITY_GUIDE = 'https://code.claude.com/docs/en/security'

type Props = {
  onAccept(): void
  onDecline(): void
  /** At startup a decline ends the process, so the answer says so. */
  declineExits?: boolean
}

type Answer = 'acceptAsDefault' | 'accept' | 'decline'

function answersFor(declineExits: boolean): Array<{ label: string; value: Answer }> {
  return [
    { label: 'Yes, and make it my default mode', value: 'acceptAsDefault' },
    { label: 'Yes, enable auto mode', value: 'accept' },
    { label: declineExits ? 'No, exit' : 'No, go back', value: 'decline' },
  ]
}

export function AutoModeOptInDialog({ onAccept, onDecline, declineExits = false }: Props) {
  // The list and the frame both hear Esc; the caller hears one answer.
  const answered = useRef(false)
  const once = (report: () => void) => {
    if (answered.current) return
    answered.current = true
    report()
  }

  const decline = () => once(onDecline)
  const answer = (value: Answer) => {
    if (value === 'decline') {
      decline()
      return
    }
    once(() => {
      recordAutoConsent({ asDefault: value === 'acceptAsDefault' })
      onAccept()
    })
  }

  return (
    <Dialog title="Enable auto mode?" color="warning" onCancel={decline}>
      <Box flexDirection="column" gap={1}>
        <Text>{AUTO_MODE_DESCRIPTION}</Text>
        <Link url={SECURITY_GUIDE} />
      </Box>
      <Select options={answersFor(declineExits)} onChange={answer} onCancel={decline} />
    </Dialog>
  )
}
