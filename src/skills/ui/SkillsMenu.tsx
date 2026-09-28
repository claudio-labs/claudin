/**
 * The /skills dialog: every skill the session has, grouped by where it came
 * from, each next to the tokens it puts in the prompt ahead of time. It is
 * read-only. Esc or n reports the dismissal through `onExit`, and the caller
 * takes the dialog down. skillsMenuModel.ts decides what is listed and how it
 * reads; this file renders it. docs/tech/rewrite/skills/SkillsMenu.md is the spec.
 */
import React, { useCallback, useMemo } from 'react'
import type { Command, CommandResultDisplay } from 'src/commands/commands.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import { formatTokens } from 'src/shared/text/format.js'
import { estimateSkillFrontmatterTokens, getSkillsPath } from 'src/skills/loadSkillsDir.js'
import { groupSkills, type SkillGroup, type SkillsMenuDeps, skillCountText } from 'src/skills/ui/skillsMenuModel.js'
import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { Box, Text } from 'src/terminal/ink.js'

type Props = {
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void
  commands: Command[]
}

const TITLE = 'Skills'
const DISMISSED = 'Skills dialog dismissed'
// Fixed text: it names the default directories whatever CLAUDIN_CONFIG_DIR says.
const CREATE_HINT = 'Create skills in .claudin/skills/ or ~/.claudin/skills/'

const deps: SkillsMenuDeps = {
  directoryOf: (source, dir) => getDisplayPath(getSkillsPath(source, dir)),
  estimateOf: skill => formatTokens(estimateSkillFrontmatterTokens(skill)),
}

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  const groups = useMemo(() => groupSkills(commands, deps), [commands])
  // Dialog binds this to confirm:no (Esc, n). Ctrl+C and Ctrl+D stay Dialog's own.
  const close = useCallback(() => onExit(DISMISSED, { display: 'system' }), [onExit])

  if (groups.length === 0) {
    return (
      <Dialog title={TITLE} subtitle="No skills found" onCancel={close} hideInputGuide>
        <Text dimColor>{CREATE_HINT}</Text>
        <CloseHint />
      </Dialog>
    )
  }

  return (
    <Dialog title={TITLE} subtitle={skillCountText(groups)} onCancel={close} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        {groups.map(group => (
          <GroupBlock key={group.source} group={group} />
        ))}
      </Box>
      <CloseHint />
    </Dialog>
  )
}

/**
 * The heading, then one line per skill. Each line is a single Text with the
 * dim parts nested in it, so a narrow terminal wraps it as one line instead
 * of as side-by-side columns (.claudin/rules/ink-tui.md §10).
 */
function GroupBlock({ group }: { group: SkillGroup }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        <Text bold>{group.title}</Text>
        {group.subtitle === undefined ? null : ` (${group.subtitle})`}
      </Text>
      {group.rows.map(row => (
        <Text key={row.key}>
          {row.label}
          <Text dimColor>{row.detail}</Text>
        </Text>
      ))}
    </Box>
  )
}

/** Stands in for Dialog's hidden input guide, showing whatever key confirm:no is bound to. */
function CloseHint(): React.ReactNode {
  return (
    <Text dimColor italic>
      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="close" />
    </Text>
  )
}
