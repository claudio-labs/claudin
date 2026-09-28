import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getCachedRemoteUrl } from 'src/vcs/git/gitFilesystem.js'
import {
  gitHubNameOf,
  type ParsedRepository,
  parseGitRemote,
  redactRemoteUserInfo,
  toGitHubName,
} from 'src/vcs/git/repository/remoteUrl.js'

type RepositoryDetectionDeps = {
  /** The session repository's origin URL, or null. */
  readonly readRemoteUrl: () => Promise<string | null>
  /** The key each answer is remembered under. */
  readonly sessionCwd: () => string
  readonly log: (message: string) => void
}

type RepositoryDetector = {
  readonly detectWithHost: () => Promise<ParsedRepository | null>
  /** `owner/name` when the session's repository is on github.com. */
  readonly detectOnGitHub: () => Promise<string | null>
  /** Every answer is forgotten. */
  readonly forget: () => void
  /** `toGitHubName`, logging what it could not read. */
  readonly gitHubNameOf: (input: string) => string | null
}

/**
 * Detects the session's repository from its origin. Each answer, null and
 * failures included, is remembered per session cwd until `forget`, so a later
 * change of the remote is not seen from a cwd that already asked. Remotes
 * reach the log only with their user-info masked, since tokens ride there.
 */
export function createRepositoryDetector(deps: RepositoryDetectionDeps): RepositoryDetector {
  const answers = new Map<string, Promise<ParsedRepository | null>>()
  const detectWithHost = (): Promise<ParsedRepository | null> => {
    const cwd = deps.sessionCwd()
    const known = answers.get(cwd)
    if (known !== undefined) return known
    const answer = detectFromOrigin(deps)
    answers.set(cwd, answer)
    return answer
  }
  return {
    detectWithHost,
    detectOnGitHub: async () => gitHubNameOf(await detectWithHost()),
    forget: () => answers.clear(),
    gitHubNameOf: input => {
      const name = toGitHubName(input)
      if (name === null) {
        deps.log(`Not a github.com repository: ${redactRemoteUserInfo(input.trim())}`)
      }
      return name
    },
  }
}

async function detectFromOrigin(
  deps: RepositoryDetectionDeps,
): Promise<ParsedRepository | null> {
  try {
    const remoteUrl = await deps.readRemoteUrl()
    if (remoteUrl === null) {
      deps.log('Repository detection: no origin remote')
      return null
    }
    const repository = parseGitRemote(remoteUrl)
    const shown = redactRemoteUserInfo(remoteUrl.trim())
    deps.log(
      repository === null
        ? `Repository detection: origin ${shown} names no repository`
        : `Repository detection: ${repository.host} ${repository.owner}/${repository.name}, from origin ${shown}`,
    )
    return repository
  } catch (error) {
    deps.log(`Repository detection failed: ${errorMessage(error)}`)
    return null
  }
}

const sessionDetector = createRepositoryDetector({
  readRemoteUrl: () => getCachedRemoteUrl(),
  sessionCwd: () => getCwd(),
  log: message => logForDebugging(message),
})

export const detectCurrentRepositoryWithHost = sessionDetector.detectWithHost
export const detectCurrentRepository = sessionDetector.detectOnGitHub
export const clearRepositoryCaches = sessionDetector.forget
export const parseGitHubRepository = sessionDetector.gitHubNameOf
