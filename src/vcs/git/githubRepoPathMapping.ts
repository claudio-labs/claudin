/**
 * Where the user keeps local clones of GitHub repositories. A facade over
 * repository/githubClones.ts, which wires repository/knownClones.ts to the
 * global config.
 */

export {
  filterExistingPaths,
  getKnownPathsForRepo,
  removePathFromRepo,
  updateGithubRepoPathMapping,
  validateRepoAtPath,
} from 'src/vcs/git/repository/githubClones.js'
