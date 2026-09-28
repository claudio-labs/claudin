/**
 * Asking git whether a path is ignored, and adding rules to the user's global
 * excludes file. A facade over repository/; suites mock.module this path.
 */

export { isPathGitignored } from 'src/vcs/git/repository/ignoreCheck.js'
export {
  addFileGlobRuleToGitignore,
  getGlobalGitignorePath,
} from 'src/vcs/git/repository/globalIgnore.js'
