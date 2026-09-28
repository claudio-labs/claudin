/**
 * The three settings files a user edits, described once: the name prompts
 * give each, who it is for, and which one wins. `/update-config` renders them
 * in the portable form that holds on any machine, `/debug` with the absolute
 * paths this session actually reads.
 */
import type { EditableSettingSource } from 'src/platform/settings/constants.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsFilePathForSource,
} from 'src/platform/settings/settings.js'

export type SettingsFile = {
  readonly source: EditableSettingSource
  /** How prompts name the file, and its word in the precedence chain. */
  readonly label: string
  /** The path as written in instructions meant for any machine. */
  readonly portablePath: string
  readonly scope: string
}

/** Lowest precedence first: each file overrides the ones before it. */
export const SETTINGS_FILES: readonly SettingsFile[] = [
  {
    source: 'userSettings',
    label: 'user',
    portablePath: '~/.claudin/settings.json',
    scope: 'personal defaults for every project',
  },
  {
    source: 'projectSettings',
    label: 'project',
    portablePath: getRelativeSettingsFilePathForSource('projectSettings'),
    scope: 'shared with the team, committed to the repository',
  },
  {
    source: 'localSettings',
    label: 'local',
    portablePath: getRelativeSettingsFilePathForSource('localSettings'),
    scope: 'personal overrides for this project, gitignored',
  },
]

const PRECEDENCE = `Precedence: ${SETTINGS_FILES.map(file => file.label).join(' → ')}. A later file overrides an earlier one.`

/** The files as a markdown list, with their paths in portable form. */
export function describeSettingsFiles(): string {
  const rows = SETTINGS_FILES.map(
    file => `- **${file.label}** \`${file.portablePath}\`: ${file.scope}`,
  )
  return `${rows.join('\n')}\n\n${PRECEDENCE}`
}

export type SettingsPathResolver = (
  source: EditableSettingSource,
) => string | undefined

/** The same list, with the absolute path of each file in this session. */
export function listResolvedSettingsFiles(
  resolvePath: SettingsPathResolver = getSettingsFilePathForSource,
): string {
  const rows = SETTINGS_FILES.map(
    file =>
      `- **${file.label}** (${file.scope}): ${resolvePath(file.source) ?? 'no path in this session'}`,
  )
  return `${rows.join('\n')}\n\n${PRECEDENCE}`
}
