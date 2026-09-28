import { readFileSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { join, resolve, sep } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/entrypoint/limits.js'
import { gitignoreSwallowsClaudinDir } from 'src/memory/memdir/location/teamGitignore.js'
import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'

const TEAM_DIR_NAME = 'team'

export function isTeamMemoryEnabled(): boolean {
  return isAutoMemoryEnabled()
}

/** `team/` inside the private directory, ending in one separator. */
export function getTeamMemPath(): string {
  return `${getAutoMemPath()}${TEAM_DIR_NAME}${sep}`
}

export function getTeamMemEntrypoint(): string {
  return join(getTeamMemPath(), ENTRYPOINT_NAME)
}

/**
 * Lexical, like isAutoMemPath: resolving against the working directory drops
 * dot segments and a trailing separator, so only files below `team/` match,
 * never `team/` itself.
 */
export function isTeamMemPath(filePath: string): boolean {
  return resolve(filePath).startsWith(getTeamMemPath())
}

export function isTeamMemFile(filePath: string): boolean {
  return isTeamMemoryEnabled() && isTeamMemPath(filePath)
}

/** Whether the repository's root `.gitignore` swallows `.claudin/`; memoized per root. */
export const isTeamMemLikelyGitIgnored = memoize((gitRoot: string): boolean => {
  const gitignorePath = join(gitRoot, '.gitignore')
  let text: string
  try {
    text = readFileSync(gitignorePath, 'utf8')
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(
        `Could not read ${gitignorePath}: ${errorMessage(error)}`,
      )
    }
    return false
  }
  return gitignoreSwallowsClaudinDir(text)
})
