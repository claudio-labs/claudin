/**
 * Project-local directory resolution for agent workflows, hardened the same way
 * as the plans directory (`src/agent/plans/plans.ts`): definitions live in
 * `<cwd>/.claudin/workflows/`, run state under `<cwd>/.claudin/workflows/.runs/`.
 * A symlink-containment check falls back to the global config dir if the project
 * `.claudin` escapes the repo root; `.runs/` is kept out of git.
 */
import { chmodSync, mkdirSync, realpathSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { join, relative, sep } from 'path'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { addFileGlobRuleToGitignore } from 'src/services/git/gitignore.js'
import { logError } from 'src/shared/log.js'

const WORKFLOWS_DIRNAME = 'workflows'
const RUNS_DIRNAME = '.runs'

export const getWorkflowsDir = memoize(function getWorkflowsDir(): string {
  const cwd = getCwd()
  let dir = join(cwd, '.claudin', WORKFLOWS_DIRNAME)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    logError(error)
  }

  // SECURITY: mirror plans.ts — the dir lives in the (attacker-controllable)
  // project tree; verify the real path stays inside the real project root, and
  // fall back to the global config dir if the check fails or can't complete.
  let contained = false
  try {
    const realCwd = realpathSync(cwd)
    const realDir = realpathSync(dir)
    contained = realDir === realCwd || realDir.startsWith(realCwd + sep)
    if (!contained) {
      logError(
        new Error(`Workflows directory escapes project root via symlink: ${dir} -> ${realDir}`),
      )
    }
  } catch (error) {
    logError(error)
  }
  if (!contained) {
    dir = join(getClaudinConfigHomeDir(), WORKFLOWS_DIRNAME)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch (error) {
      logError(error)
    }
  }

  try {
    chmodSync(dir, 0o700)
  } catch {
    // best-effort; not all filesystems honor unix permission bits
  }
  return dir
}, getCwd)

export const getWorkflowRunsDir = memoize(function getWorkflowRunsDir(): string {
  const dir = join(getWorkflowsDir(), RUNS_DIRNAME)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    logError(error)
  }
  try {
    // mkdir's mode is a no-op when the dir pre-exists (and is umask-masked on
    // creation); run JSON can hold task text, so pin 0700 explicitly.
    chmodSync(dir, 0o700)
  } catch {
    // best-effort; not all filesystems honor unix permission bits
  }
  // Definitions (*.md) are meant to be committable; run state is not — keep
  // .runs/ out of git without touching the tracked .gitignore.
  const cwd = getCwd()
  if (dir.startsWith(cwd + sep)) {
    void addFileGlobRuleToGitignore(`${relative(cwd, dir)}/`, cwd)
  }
  return dir
}, getCwd)
