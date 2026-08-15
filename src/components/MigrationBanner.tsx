import * as React from 'react'

import { Box, Text } from 'src/ink.js'
import {
  formatMigrationReport,
  markMigrationSkipped,
  migrateLegacyClaudeDir,
  type MigrationReport,
} from 'src/services/config/claudinMigration.js'
import { Select } from 'src/components/CustomSelect/index.js'

type Phase =
  | { kind: 'prompt' }
  | { kind: 'running' }
  | { kind: 'success'; report: MigrationReport }
  | { kind: 'error'; report: MigrationReport }
  | { kind: 'hidden' }

export type MigrationOutcome = 'migrated' | 'skipped'

export function MigrationBanner({
  enabled,
  onDismiss,
}: {
  enabled: boolean
  onDismiss?: (outcome: MigrationOutcome) => void
}): React.ReactNode {
  const [phase, setPhase] = React.useState<Phase>(() =>
    enabled ? { kind: 'prompt' } : { kind: 'hidden' },
  )

  if (!enabled || phase.kind === 'hidden') {
    return null
  }

  if (phase.kind === 'running') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="warning" bold>
          Migrating ~/.claude/ to ~/.claudin/...
        </Text>
        <Text dimColor>
          Copying tokens, settings, theme, MCP servers, skills, agents, slash commands, plugins, and keybindings.
        </Text>
      </Box>
    )
  }

  if (phase.kind === 'success' || phase.kind === 'error') {
    const color = phase.kind === 'success' ? 'success' : 'warning'
    const heading =
      phase.kind === 'success' ? 'Migration complete' : 'Migration finished with warnings'
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={color} bold>
          {heading}
        </Text>
        <Text>{formatMigrationReport(phase.report)}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="warning" bold>
        Found Claude Code config at ~/.claude/
      </Text>
      <Text>
        Import API tokens, settings, theme, MCP servers, skills, agents, slash commands, plugins, and keybindings into ~/.claudin/?
      </Text>
      <Select
        options={[
          {
            value: 'migrate',
            label: 'Migrate now',
            description:
              'Copy tokens, settings, CLAUDE.md, skills, agents, commands, plugins, keybindings.',
          },
          {
            value: 'skip',
            label: 'Skip — start fresh',
            description: "Don't ask again this profile.",
          },
        ]}
        onChange={(value: string) => {
          if (value === 'skip') {
            markMigrationSkipped()
            setPhase({ kind: 'hidden' })
            onDismiss?.('skipped')
            return
          }
          setPhase({ kind: 'running' })
          void (async () => {
            const report = await migrateLegacyClaudeDir()
            setPhase({
              kind: report.errors.length === 0 ? 'success' : 'error',
              report,
            })
            onDismiss?.('migrated')
          })()
        }}
        // Esc dismisses without persisting — re-prompt on next launch.
        onCancel={() => {
          setPhase({ kind: 'hidden' })
          onDismiss?.('skipped')
        }}
        visibleOptionCount={2}
      />
    </Box>
  )
}
