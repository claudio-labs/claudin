import { homedir } from 'os'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import { getSettingsRootPathForSource } from 'src/platform/settings/settings.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getPlatform } from 'src/shared/proc/platform.js'

/** Every directory a file rule's pattern can be matched from. */
export type RuleAnchors = {
  /** Unanchored patterns: the session's current directory, which can move. */
  readonly currentDir: string
  /** `/` patterns from the session, the CLI and project-level settings. */
  readonly startingDir: string
  /** `~/` patterns. */
  readonly homeDir: string
  /** `/` patterns from user settings. */
  readonly configHomeDir: string
  /** `/` patterns from `--settings`: that file's directory, or the starting directory. */
  readonly settingsFileDir: string
  /** `//c/...` names a drive, and paths are compared in POSIX form. */
  readonly windows: boolean
}

type SourceAnchor = 'startingDir' | 'configHomeDir' | 'settingsFileDir'

const SOURCE_ANCHOR: Record<PermissionRuleSource, SourceAnchor> = {
  userSettings: 'configHomeDir',
  flagSettings: 'settingsFileDir',
  projectSettings: 'startingDir',
  localSettings: 'startingDir',
  policySettings: 'startingDir',
  cliArg: 'startingDir',
  command: 'startingDir',
  session: 'startingDir',
}

export function anchorDirOfSource(source: PermissionRuleSource, anchors: RuleAnchors): string {
  return anchors[SOURCE_ANCHOR[source]]
}

/** Reads the anchors from the session state, once per query. */
export function liveRuleAnchors(): RuleAnchors {
  return {
    currentDir: getCwd(),
    startingDir: getSettingsRootPathForSource('projectSettings'),
    homeDir: homedir(),
    configHomeDir: getSettingsRootPathForSource('userSettings'),
    settingsFileDir: getSettingsRootPathForSource('flagSettings'),
    windows: getPlatform() === 'windows',
  }
}
