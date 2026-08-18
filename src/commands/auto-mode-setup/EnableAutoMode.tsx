import React from 'react'

import { Box, Text } from 'src/terminal/ink.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { Select } from 'src/terminal/custom-select/index.js'
import { AUTO_MODE_DESCRIPTION } from 'src/permissions/ui/AutoModeOptInDialog.js'

export type EnableChoice = 'enable' | 'enable-default' | 'skip'

type Props = {
  onChoose(choice: EnableChoice): void
}

/** Offered after the rules are written; auto mode is never turned on silently. */
export function EnableAutoMode({ onChoose }: Props): React.ReactNode {
  return (
    <Dialog
      title="Rules saved. Turn auto mode on?"
      color="warning"
      onCancel={() => onChoose('skip')}
    >
      <Box flexDirection="column" gap={1}>
        <Text>{AUTO_MODE_DESCRIPTION}</Text>
        <Select
          options={[
            { label: 'Yes, enable auto mode', value: 'enable' },
            {
              label: 'Yes, and make it my default mode',
              value: 'enable-default',
            },
            { label: 'No, just keep the rules', value: 'skip' },
          ]}
          onChange={value => onChoose(value as EnableChoice)}
          onCancel={() => onChoose('skip')}
        />
      </Box>
    </Dialog>
  )
}
