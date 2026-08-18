import React from 'react'

import { Box, Text } from 'src/terminal/ink.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { Spinner } from 'src/terminal/spinner/Spinner.js'

export type ScanStep = {
  label: string
  status: 'pending' | 'running' | 'done' | 'skipped'
}

type Props = {
  steps: readonly ScanStep[]
  onCancel(): void
}

const STATUS_GLYPH: Record<ScanStep['status'], string> = {
  pending: '  ',
  running: '▸ ',
  done: '✓ ',
  skipped: '– ',
}

/** The blocking scan screen: local collection, then the model call. */
export function ScanProgress({ steps, onCancel }: Props): React.ReactNode {
  return (
    <Dialog title="Analyzing your environment" onCancel={onCancel}>
      <Box flexDirection="column">
        {steps.map(step => (
          <Text
            key={step.label}
            dimColor={step.status === 'pending' || step.status === 'skipped'}
          >
            {STATUS_GLYPH[step.status]}
            {step.label}
          </Text>
        ))}
        <Box marginTop={1}>
          <Spinner />
        </Box>
      </Box>
    </Dialog>
  )
}
