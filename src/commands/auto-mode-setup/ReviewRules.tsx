import React from 'react'

import { Box, Text } from 'src/terminal/ink.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { Select } from 'src/terminal/custom-select/index.js'
import { DEFAULTS_SENTINEL } from 'src/permissions/autoModeRules.js'
import type { SectionDiff } from 'src/commands/auto-mode-setup/applyRules.js'

type Props = {
  diff: readonly SectionDiff[]
  notes: readonly string[]
  onAccept(): void
  onCancel(): void
}

const SECTION_TITLE: Record<SectionDiff['section'], string> = {
  allow: 'Auto-approve',
  soft_deny: 'Always ask',
  environment: 'Environment',
}

/**
 * Shows what would change before anything is written. `$defaults` is rendered
 * as what it means rather than as a literal, since it is the entry that keeps
 * the shipped rules in force.
 */
export function ReviewRules({
  diff,
  notes,
  onAccept,
  onCancel,
}: Props): React.ReactNode {
  return (
    <Dialog title="Proposed auto mode rules" onCancel={onCancel}>
      <Box flexDirection="column" gap={1}>
        {diff.map(section => (
          <Box key={section.section} flexDirection="column">
            <Text bold>{SECTION_TITLE[section.section]}</Text>
            {section.added.length === 0 && section.removed.length === 0 ? (
              <Text dimColor>{'  no change'}</Text>
            ) : null}
            {section.added.map(entry => (
              <Text key={`+${entry}`} color="success">
                {'  + '}
                {renderEntry(entry)}
              </Text>
            ))}
            {section.removed.map(entry => (
              <Text key={`-${entry}`} color="error">
                {'  - '}
                {renderEntry(entry)}
              </Text>
            ))}
          </Box>
        ))}

        {notes.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Notes</Text>
            {notes.map(note => (
              <Text key={note} dimColor>
                {'  '}
                {note}
              </Text>
            ))}
          </Box>
        ) : null}

        <Text dimColor>
          These are written to your user settings. Settings inside a repository
          cannot configure auto mode.
        </Text>

        <Select
          options={[
            { label: 'Apply these rules', value: 'apply' },
            { label: 'Cancel, write nothing', value: 'cancel' },
          ]}
          onChange={value => (value === 'apply' ? onAccept() : onCancel())}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}

function renderEntry(entry: string): string {
  return entry === DEFAULTS_SENTINEL
    ? 'the shipped default rules (kept)'
    : entry
}
