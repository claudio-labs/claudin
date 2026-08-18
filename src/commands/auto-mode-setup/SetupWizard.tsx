import React, { useState } from 'react'

import { Box, Text } from 'src/terminal/ink.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { Select, SelectMulti } from 'src/terminal/custom-select/index.js'
import type { UsagePosture } from 'src/commands/auto-mode-setup/collectSignals.js'

export type WizardChoice = {
  posture: UsagePosture
  includeShellHistory: boolean
}

type Props = {
  onSubmit(choice: WizardChoice): void
  onCancel(): void
}

const POSTURE_OPTIONS: {
  label: string
  value: UsagePosture
  description: string
}[] = [
  {
    label: 'Work',
    value: 'work',
    description: 'Company code, shared infrastructure, deploy targets',
  },
  {
    label: 'Open source',
    value: 'open-source',
    description: 'Public repository, contributions, published releases',
  },
  {
    label: 'Hobby',
    value: 'hobby',
    description: 'Personal projects on this machine only',
  },
  {
    label: 'Mixed',
    value: 'mixed',
    description: 'A bit of each — the safe default',
  },
]

const SHELL_HISTORY = 'shell-history'

/**
 * The two questions asked before the scan. Kept as two screens rather than one
 * form: the tree has no horizontal option cycler, and Select/SelectMulti
 * already handle focus and keyboard for a vertical list.
 */
export function SetupWizard({ onSubmit, onCancel }: Props): React.ReactNode {
  const [posture, setPosture] = useState<UsagePosture | null>(null)

  if (posture === null) {
    return (
      <Dialog
        title="Set up auto mode for your environment?"
        onCancel={onCancel}
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            Claudin reads this project, your recent sessions, and optionally your
            shell history. It then proposes rules for the auto mode classifier —
            nothing is written until you review them.
          </Text>
          <Text bold>How do you use Claudin here?</Text>
          <Select
            options={POSTURE_OPTIONS}
            onChange={value => setPosture(value as UsagePosture)}
            onCancel={onCancel}
          />
        </Box>
      </Dialog>
    )
  }

  return (
    <Dialog title="What may the scan read?" onCancel={onCancel}>
      <Box flexDirection="column" gap={1}>
        <Text>
          This project and your recent sessions are always read. Shell history is
          reduced to counted command names — no arguments, paths or URLs leave
          your machine.
        </Text>
        <SelectMulti
          options={[
            {
              label: 'Also scan shell history',
              value: SHELL_HISTORY,
              description: 'Command names only, from an allowlist of binaries',
            },
          ]}
          defaultValue={[]}
          submitButtonText="Continue"
          hideIndexes
          onSubmit={values =>
            onSubmit({
              posture,
              includeShellHistory: values.includes(SHELL_HISTORY),
            })
          }
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}
