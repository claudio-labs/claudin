/**
 * Which repository a remote names, and which one the session is in. A facade
 * over repository/remoteUrl.ts (the parsers) and repository/repositoryDetection.ts.
 */

export type { ParsedRepository } from 'src/vcs/git/repository/remoteUrl.js'
export { parseGitRemote } from 'src/vcs/git/repository/remoteUrl.js'
export {
  clearRepositoryCaches,
  detectCurrentRepository,
  detectCurrentRepositoryWithHost,
  parseGitHubRepository,
} from 'src/vcs/git/repository/repositoryDetection.js'
