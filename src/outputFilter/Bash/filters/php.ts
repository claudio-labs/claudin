// PHP toolchain filters — Phase 13 (rtk gap-fill).
//
//   - composer install/update/require : strip the Loading/Updating preamble and
//     the per-package Downloading/Installing lines; collapse a no-op run
//     ("Nothing to install, update or remove") to a sentinel; keep "Writing lock
//     file" / "Generating autoload files" and any resolution error.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

const COMPOSER_MATCH = /^composer\s+(?:install|update|require)\b/
const COMPOSER_LOADING = /^Loading composer repositories/
const COMPOSER_UPDATING = /^Updating dependencies/
const COMPOSER_DOWNLOADING = /^\s+-\s+Downloading\s/
const COMPOSER_INSTALLING = /^\s+-\s+Installing\s.*\(/
const COMPOSER_LOCK_OPS = /^Lock file operations:/
// Composer prints this on a no-op run; collapse the whole thing.
const COMPOSER_NOTHING = /Nothing to install, update or remove|Nothing to modify in lock file/
// Unsatisfiable constraints / exceptions — never collapse. Warnings, abandoned-
// package notices, and deprecation notices also suppress the no-op sentinel: a
// `require`/`update` can finish (exit 0) yet print one we must not hide.
const COMPOSER_HAS_PROBLEM = /could not be resolved|^\s*Problem \d|\[\w*Exception\]|fatal:|\bwarning\b|\babandoned\b|Deprecation Notice/im

export const composer: FilterSpec = {
  name: 'composer',
  matchCommand: COMPOSER_MATCH,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: COMPOSER_NOTHING,
      unless: COMPOSER_HAS_PROBLEM,
      message: '✓ composer: nothing to install or update',
    },
  ],
  stripLinesMatching: [
    COMPOSER_LOADING,
    COMPOSER_UPDATING,
    COMPOSER_DOWNLOADING,
    COMPOSER_INSTALLING,
    COMPOSER_LOCK_OPS,
  ],
  collapseRuns: true,
  maxLines: 30,
}
