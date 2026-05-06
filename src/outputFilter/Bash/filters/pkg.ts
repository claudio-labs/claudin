// Package-manager filters: bundle install, (more in batch 2 / 6.1.5).
//
// Regex are declared at module level — see .claude/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- bundle install ------------------------------------------------------

const BUNDLE_INSTALL_MATCH = /^bundle\s+install\b/
// One `Fetching <gem>` line per dependency — pure noise, the `Installing`
// lines cover the same gems with the same versions.
const BUNDLE_INSTALL_STRIP_FETCHING = /^Fetching\s/
// Success sentinel — emitted on the final line of a clean install.
const BUNDLE_INSTALL_OK = /Bundle complete!/
// Safety guard: never collapse when Bundler is reporting a problem.
const BUNDLE_INSTALL_HAS_PROBLEM = /(?:^|\s)(error|conflict|could not find|resolution)/i

export const bundleInstall: FilterSpec = {
  name: 'bundle-install',
  matchCommand: BUNDLE_INSTALL_MATCH,
  stripAnsi: true,
  stripLinesMatching: [BUNDLE_INSTALL_STRIP_FETCHING],
  matchOutput: [
    {
      pattern: BUNDLE_INSTALL_OK,
      unless: BUNDLE_INSTALL_HAS_PROBLEM,
      message: '✓ bundle install completed',
    },
  ],
}
