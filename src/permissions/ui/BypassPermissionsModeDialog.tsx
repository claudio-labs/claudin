import React from 'react'
import { Box, Link, Text } from 'src/terminal/ink.js'
import { gracefulShutdownSync } from 'src/shared/proc/gracefulShutdown.js'
import { Select } from 'src/terminal/custom-select/index.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { recordBypassAccepted } from 'src/permissions/ui/modeDialogs/consentSettings.js'

const SECURITY_GUIDE = 'https://code.claude.com/docs/en/security'

/** Refusing ends the process with 1; cancelling (Esc) with 0 (finding 2, kept). */
type ExitCode = 0 | 1

type Props = {
  onAccept(): void
  /** How the process ends when the warning is refused or cancelled. Startup leaves the default. */
  exitProcess?: (code: ExitCode) => void
}

type Answer = 'refuse' | 'accept'

const ANSWERS: Array<{ label: string; value: Answer }> = [
  { label: 'No, exit', value: 'refuse' },
  { label: 'Yes, I accept', value: 'accept' },
]

function endProcess(code: ExitCode): void {
  gracefulShutdownSync(code)
}

export function BypassPermissionsModeDialog({ onAccept, exitProcess = endProcess }: Props) {
  const answer = (value: Answer) => {
    if (value !== 'accept') {
      exitProcess(1)
      return
    }
    // Recorded before the caller hears of it, so the caller can read it back.
    recordBypassAccepted()
    onAccept()
  }

  return (
    <Dialog title="WARNING: Claudin running in Bypass Permissions mode" color="error" onCancel={() => exitProcess(0)}>
      <Box flexDirection="column" gap={1}>
        <Text>
          In Bypass Permissions mode, Claudin will not ask for your approval before running potentially dangerous
          commands.
        </Text>
        <Text>
          Use it only inside a sandboxed container/VM with restricted internet access, one that can easily be restored if
          damaged.
        </Text>
        <Text>By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.</Text>
        <Link url={SECURITY_GUIDE} />
      </Box>
      <Select options={ANSWERS} onChange={answer} />
    </Dialog>
  )
}
