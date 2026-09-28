/**
 * Where auto memory lives, and the switches that turn it on.
 *
 *   CLAUDE_COWORK_MEMORY_PATH_OVERRIDE  an absolute directory that wins over
 *                                       every setting; `~` is not expanded.
 *   CLAUDE_CODE_REMOTE_MEMORY_DIR       a mounted memory base for remote
 *                                       sessions, used instead of the config home.
 */
import { chmodSync, mkdirSync, realpathSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join, normalize } from 'path'
import { getProjectRoot } from 'src/platform/bootstrap/state.js'
import { getSettingsForSource } from 'src/platform/settings/settings.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { findCanonicalGitRoot } from 'src/vcs/git/git.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/entrypoint/limits.js'
import { resolveMemoryLocation } from 'src/memory/memdir/location/memoryLocation.js'
import { validateMemoryDirOverride } from 'src/memory/memdir/location/overrideValidation.js'
import {
  adoptProjectLocalDir,
  type ProjectLocalFs,
} from 'src/memory/memdir/location/projectLocalDir.js'
import { migrateGlobalMemoryIfNeeded } from 'src/memory/memdir/memoryMigration.js'

export { isAutoMemoryEnabled } from 'src/memory/memdir/switches/autoMemorySwitch.js'
export {
  getExtractionTurnInterval,
  isExtractMemoriesEnabled,
  isExtractModeActive,
} from 'src/memory/memdir/switches/extractionSwitches.js'

/** The remote memory mount when one is set, else the config home. */
export function getMemoryBaseDir(): string {
  return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR || getClaudinConfigHomeDir()
}

/** Only the environment variable counts; the `autoMemoryDirectory` setting does not. */
export function hasAutoMemPathOverride(): boolean {
  return validateMemoryDirOverride(
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
    { expandHome: false, homeDir: homedir() },
  ).ok
}

const PROJECT_LOCAL_FS: ProjectLocalFs = {
  makeDir: (dir, mode) => {
    mkdirSync(dir, { recursive: true, mode })
  },
  realPath: path => realpathSync(path),
  setMode: (path, mode) => chmodSync(path, mode),
}

// Lives beside the memo so that a fresh import of this module starts with
// neither: the copy of legacy memory is offered once per project root.
const copiedLegacyRoots = new Set<string>()

function resolveAutoMemPath(): string {
  const projectRoot = getProjectRoot()
  const location = resolveMemoryLocation({
    envOverride: process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
    readLayer: source => getSettingsForSource(source),
    homeDir: homedir(),
    projectRoot,
    repoRoot: findCanonicalGitRoot(projectRoot),
    memoryBase: getMemoryBaseDir(),
  })
  if (location.kind !== 'project-local') return location.dir
  const usable = adoptProjectLocalDir(location, projectRoot, {
    fs: PROJECT_LOCAL_FS,
    copyLegacyMemory: migrateGlobalMemoryIfNeeded,
    copiedRoots: copiedLegacyRoots,
  })
  return usable ? location.dir : location.legacyDir
}

/**
 * The private memory directory, ending in one separator. Memoized per project
 * root: changes to the environment, the settings or the config home are seen
 * only after `getAutoMemPath.cache.clear()`, which rerooting a session calls.
 */
export const getAutoMemPath = memoize(resolveAutoMemPath, () =>
  getProjectRoot(),
)

export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), ENTRYPOINT_NAME)
}

/**
 * Lexical: dot segments are resolved, symlinks are not. The directory's own
 * trailing separator is part of the prefix, so a sibling such as
 * `memory-old/` never matches.
 */
export function isAutoMemPath(absolutePath: string): boolean {
  return normalize(absolutePath).startsWith(getAutoMemPath())
}
