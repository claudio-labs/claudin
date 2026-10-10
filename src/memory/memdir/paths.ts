import { chmodSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from 'src/platform/bootstrap/state.js'
import {
  getClaudinConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from 'src/shared/envUtils.js'
import { validateBoundedIntEnvVar } from 'src/shared/envValidation.js'
import { findCanonicalGitRoot } from 'src/vcs/git/git.js'
import { logError } from 'src/shared/log.js'
import { logForDebugging } from 'src/shared/debug.js'
import { sanitizePath } from 'src/shared/fs/path.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from 'src/platform/settings/settings.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { migrateLegacyMemoryIfNeeded } from 'src/memory/memdir/memoryMigration.js'

/**
 * Whether auto-memory features are enabled (memdir, agent memory, past session search).
 * Enabled by default. Priority chain (first defined wins):
 *   1. CLAUDIN_DISABLE_AUTO_MEMORY env var (1/true → OFF, 0/false → ON)
 *   2. CLAUDIN_SIMPLE (--bare) → OFF
 *   3. CCR without persistent storage → OFF (no CLAUDE_CODE_REMOTE_MEMORY_DIR)
 *   4. autoMemoryEnabled in settings.json (supports project-level opt-out)
 *   5. Default: enabled
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.CLAUDIN_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) {
    return false
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true
  }
  // --bare / SIMPLE: prompts.ts already drops the memory section from the
  // system prompt via its SIMPLE early-return; this gate stops the other half
  // (extractMemories turn-end fork, autoDream, /remember, /dream, team sync).
  if (isEnvTruthy(process.env.CLAUDIN_SIMPLE)) {
    return false
  }
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  ) {
    return false
  }
  const settings = getInitialSettings()
  if (settings.autoMemoryEnabled !== undefined) {
    return settings.autoMemoryEnabled
  }
  return true
}

/**
 * The background memory-extraction agent. On by default in this fork;
 * upstream shipped it off. CLAUDIN_EXTRACT_MEMORIES=0 is the killswitch, and
 * it sits under `isAutoMemoryEnabled()`, which turns the whole memory system
 * off.
 */
export function isExtractMemoriesEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_EXTRACT_MEMORIES)
}

/**
 * Whether the extract-memories background agent will run this session.
 *
 * The main agent's prompt always has full save instructions regardless of
 * this gate — when the main agent writes memories, the background agent
 * skips that range (hasMemoryWritesSince in extractMemories.ts); when it
 * doesn't, the background agent catches anything missed.
 *
 * Callers must also gate on feature('EXTRACT_MEMORIES') — that check cannot
 * live inside this helper because feature() only tree-shakes when used
 * directly in an `if` condition.
 *
 * Interactive sessions only: a `-p` run ends before a background fork could
 * report back. CLAUDIN_EXTRACT_MEMORIES_HEADLESS=1 lets a `-p` run extract
 * too, and wait for it before exiting (drainPendingExtraction) — what
 * scripts/bench/ab/extract-memories-ab.ts measures through.
 */
export function isExtractModeActive(): boolean {
  return (
    isExtractMemoriesEnabled() &&
    (!getIsNonInteractiveSession() ||
      isEnvTruthy(process.env.CLAUDIN_EXTRACT_MEMORIES_HEADLESS))
  )
}

const DEFAULT_EXTRACTION_TURN_INTERVAL = 15

/**
 * How many eligible turns pass between two background extractions. A trailing
 * run and a repeated-error loop bypass it (extractMemories.ts).
 *
 * 15 in this fork, where upstream fired every turn: a fire costs ~2-4k
 * effective tokens, mostly cache_read at 10%, so this amortizes to
 * ~130-270 tokens a turn. CLAUDIN_EXTRACT_MEMORIES_EVERY=<n> overrides it;
 * a value that is not a positive integer keeps the default.
 */
export function getExtractionTurnInterval(): number {
  return validateBoundedIntEnvVar(
    'CLAUDIN_EXTRACT_MEMORIES_EVERY',
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY,
    DEFAULT_EXTRACTION_TURN_INTERVAL,
    1000,
  ).effective
}

/**
 * Returns the base directory for persistent memory storage.
 * Resolution order:
 *   1. CLAUDE_CODE_REMOTE_MEMORY_DIR env var (explicit override, set in CCR)
 *   2. ~/.claudin (default config home)
 */
export function getMemoryBaseDir(): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  }
  return getClaudinConfigHomeDir()
}

const AUTO_MEM_DIRNAME = 'memory'

/**
 * Normalize and validate a candidate auto-memory directory path.
 *
 * SECURITY: Rejects paths that would be dangerous as a read-allowlist root
 * or that normalize() doesn't fully resolve:
 * - relative (!isAbsolute): "../foo" — would be interpreted relative to CWD
 * - root/near-root (length < 3): "/" → "" after strip; "/a" too short
 * - Windows drive-root (C: regex): "C:\" → "C:" after strip
 * - UNC paths (\\server\share): network paths — opaque trust boundary
 * - null byte: survives normalize(), can truncate in syscalls
 *
 * Returns the normalized path with exactly one trailing separator,
 * or undefined if the path is unset/empty/rejected.
 */
function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) {
    return undefined
  }
  let candidate = raw
  // Settings.json paths support ~/ expansion (user-friendly). The env var
  // override does not (it's set programmatically by Cowork/SDK, which should
  // always pass absolute paths). Bare "~", "~/", "~/.", "~/..", etc. are NOT
  // expanded — they would make the memory carve-out match all of $HOME or its
  // parent (same class of danger as "/" or "C:\").
  if (
    expandTilde &&
    (candidate.startsWith('~/') || candidate.startsWith('~\\'))
  ) {
    const rest = candidate.slice(2)
    // Reject trivial remainders that would expand to $HOME or an ancestor.
    // normalize('') = '.', normalize('.') = '.', normalize('foo/..') = '.',
    // normalize('..') = '..', normalize('foo/../..') = '..'
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined
    }
    candidate = join(homedir(), rest)
  }
  // normalize() may preserve a trailing separator; strip before adding
  // exactly one to match the trailing-sep contract of getPrivateMemPath()
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}

/**
 * SECURITY: whether `dir` holds the config home. A memory directory's files
 * are read and written with no prompt (internalPaths.ts), so one that held
 * ~/.claudin would put settings.json under that carve-out.
 */
function containsConfigHome(dir: string): boolean {
  return (getClaudinConfigHomeDir() + sep).normalize('NFC').startsWith(dir)
}

/**
 * A memory setting from the sources a repo cannot write: policy, flag and
 * user. SECURITY: never projectSettings, and never localSettings either —
 * settings.local.json lives in the repo, gitignored by convention only
 * (settings.ts AUTO_MODE_REPO_CONTROLLED_SOURCES), and these settings decide
 * where the no-prompt memory carve-out (internalPaths.ts) applies.
 */
function trustedMemorySetting<
  K extends 'autoMemoryDirectory' | 'autoMemoryGlobalDirectory' | 'autoMemoryProjectLocal',
>(key: K) {
  return (
    getSettingsForSource('policySettings')?.[key] ??
    getSettingsForSource('flagSettings')?.[key] ??
    getSettingsForSource('userSettings')?.[key]
  )
}

/** A memory directory setting, validated, and refused when it holds the config home. */
function memoryDirSetting(
  key: 'autoMemoryDirectory' | 'autoMemoryGlobalDirectory',
): string | undefined {
  const dir = validateMemoryPath(trustedMemorySetting(key), true)
  return dir === undefined || containsConfigHome(dir) ? undefined : dir
}

/** Whether two directories (trailing separators) are one inside the other, or the same. */
function nests(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * Direct override for the full auto-memory directory path via env var.
 * When set, getPrivateMemPath() returns this path directly
 * instead of computing `{base}/projects/{sanitized-cwd}/memory/`.
 *
 * Used by Cowork to redirect memory to a space-scoped mount where the
 * per-session cwd (which contains the VM process name) would otherwise
 * produce a different project-key for every session.
 */
function getMemoryPathOverride(): string | undefined {
  return validateMemoryPath(
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
    false,
  )
}

/**
 * Check if CLAUDE_COWORK_MEMORY_PATH_OVERRIDE is set to a valid override.
 * Use this as a signal that the SDK caller has explicitly opted into
 * the auto-memory mechanics — e.g. to decide whether to inject the
 * memory prompt when a custom system prompt replaces the default.
 */
export function hasMemoryPathOverride(): boolean {
  return getMemoryPathOverride() !== undefined
}

/**
 * Whether the project-local auto-memory default (<gitRoot>/.claudin/memory/)
 * is enabled. Defaults to true; set autoMemoryProjectLocal: false to force
 * the legacy per-project location under the config home. Read from the same
 * sources as the directory settings, for one trust model.
 */
function isAutoMemProjectLocalEnabled(): boolean {
  return trustedMemorySetting('autoMemoryProjectLocal') !== false
}

/**
 * Returns the canonical git repo root if available, otherwise falls back to
 * the stable project root. Uses findCanonicalGitRoot so all worktrees of the
 * same repo share one auto-memory directory (anthropics/claude-code#24382).
 */
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}

/**
 * Returns the auto-memory directory path.
 *
 * Resolution order:
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE env var (full-path override, used by Cowork)
 *   2. autoMemoryDirectory in settings.json (trusted sources only: policy/local/user)
 *   3. <gitRoot>/.claudin/memory/ when the project is a git repo and
 *      autoMemoryProjectLocal isn't false (see getProjectLocalMemPath below)
 *   4. <memoryBase>/projects/<sanitized-git-root>/memory/
 *      where memoryBase is resolved by getMemoryBaseDir() — used for non-git
 *      projects, and as the fallback whenever step 3 can't be verified safe
 *
 * Memoized: render-path callers (collapseReadSearchGroups → isAutoManagedMemoryFile)
 * fire per tool-use message per Messages re-render; each miss costs
 * getSettingsForSource × 4 → parseSettingsFile (realpathSync + readFileSync).
 * Keyed on projectRoot so tests that change its mock mid-block recompute;
 * env vars / settings.json / CLAUDIN_CONFIG_DIR are session-stable in
 * production and covered by per-test cache.clear.
 */
export const getPrivateMemPath = memoize(
  (): string => {
    const override = getMemoryPathOverride() ?? memoryDirSetting('autoMemoryDirectory')
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    const legacyPath = (
      join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC')

    if (!isAutoMemProjectLocalEnabled()) {
      return legacyPath
    }
    const gitRoot = findCanonicalGitRoot(getProjectRoot())
    if (!gitRoot) {
      return legacyPath
    }

    const projectLocalPath = (
      join(gitRoot, '.claudin', AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC')

    // A repo rooted at $HOME would put its private dir at ~/.claudin/memory/
    // — the global dir — and every other project would then load this
    // project's private and team memories as global ones.
    if (nests(projectLocalPath, getGlobalMemPath())) {
      logForDebugging(
        `[memory] ${projectLocalPath} is the global memory dir; using ${legacyPath} for this project`,
      )
      return legacyPath
    }

    try {
      getFsImplementation().mkdirSync(projectLocalPath, { mode: 0o700 })
    } catch (error) {
      logError(error)
      return legacyPath
    }

    // SECURITY: the memory directory now lives inside the project tree,
    // whose contents an attacker controls if the user opens/clones a hostile
    // repo. mkdirSync above follows existing symlink components lexically,
    // and the memory carve-out (internalPaths.ts) auto-approves reads/writes under this path
    // with no prompt — so a `.claudin` symlink planted in the repo could
    // otherwise turn auto-memory into an unprompted read/write primitive
    // against an arbitrary location. Verify the real path is still contained
    // in the real git root; fall back to the legacy per-project dir if the check
    // fails OR can't be completed — an unverifiable path must be treated as
    // unsafe, not used as-is, since this value gets memoized for the process.
    // Mirrors getPlansDirectory() in src/agent/plans/plans.ts.
    let containmentVerified = false
    try {
      const realRoot = getFsImplementation().realpathSync(gitRoot)
      const realProjectLocalPath =
        getFsImplementation().realpathSync(projectLocalPath)
      containmentVerified =
        realProjectLocalPath === realRoot ||
        realProjectLocalPath.startsWith(realRoot + sep)
      if (!containmentVerified) {
        logError(
          new Error(
            `Auto-memory directory escapes project root via symlink: ${projectLocalPath} -> ${realProjectLocalPath}`,
          ),
        )
      }
    } catch (error) {
      logError(error)
    }
    if (!containmentVerified) {
      return legacyPath
    }

    // Belt-and-suspenders: force restrictive permissions even if the
    // directory already existed without this mode set.
    try {
      chmodSync(projectLocalPath, 0o700)
    } catch {
      // best-effort; not all platforms/filesystems honor unix permission bits
    }

    migrateLegacyMemoryIfNeeded(legacyPath, projectLocalPath)

    return projectLocalPath
  },
  () => getProjectRoot(),
)

/**
 * The global memory directory: `<memoryBase>/memory/`, or
 * autoMemoryGlobalDirectory (memoryDirSetting: trusted sources, ~/
 * expansion, never the config home). One for the user, shared by every project — it
 * holds what is about the person (`type: user`, feedback that applies in any
 * project), so a new project starts knowing who the user is. Trailing
 * separator, like getPrivateMemPath(). Memoized for the same render-path reason,
 * keyed on the two variables getMemoryBaseDir() reads.
 */
export const getGlobalMemPath = memoize(
  (): string =>
    memoryDirSetting('autoMemoryGlobalDirectory') ??
    (join(getMemoryBaseDir(), AUTO_MEM_DIRNAME) + sep).normalize('NFC'),
  () =>
    `${process.env.CLAUDIN_CONFIG_DIR ?? ''}\0${process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR ?? ''}`,
)

/**
 * Why the global memory directory is off, or null while it is on. On
 * whenever auto memory is; CLAUDIN_GLOBAL_MEMORY=0 turns it off, and memory
 * is the private and team directories only, as before it existed — a
 * `type: user` memory is private again. Also off when a Cowork/SDK caller
 * designated the memory directory (it gets exactly that directory), and when
 * a setting makes the global and private directories nest, which would make
 * every file in the inner one belong to both. (A repo rooted at $HOME never
 * gets there: getPrivateMemPath moves its private dir instead.) `/memory global`
 * reports the reason; everything else asks isGlobalMemoryEnabled.
 */
export type GlobalMemoryOff =
  | { reason: 'auto-memory-off' }
  | { reason: 'env' }
  | { reason: 'cowork-override' }
  | { reason: 'nested'; globalDir: string; privateDir: string }

export function globalMemoryOffReason(): GlobalMemoryOff | null {
  if (!isAutoMemoryEnabled()) return { reason: 'auto-memory-off' }
  if (isEnvDefinedFalsy(process.env.CLAUDIN_GLOBAL_MEMORY)) return { reason: 'env' }
  if (hasMemoryPathOverride()) return { reason: 'cowork-override' }
  const globalDir = getGlobalMemPath()
  const privateDir = getPrivateMemPath()
  if (nests(globalDir, privateDir)) {
    logForDebugging(`[memory] global memory off: ${globalDir} and ${privateDir} nest`)
    return { reason: 'nested', globalDir, privateDir }
  }
  return null
}

export function isGlobalMemoryEnabled(): boolean {
  return globalMemoryOffReason() === null
}
