import { chmodSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from 'src/platform/bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import {
  getClaudinConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from 'src/shared/envUtils.js'
import { findCanonicalGitRoot } from 'src/vcs/git/git.js'
import { logError } from 'src/shared/log.js'
import { sanitizePath } from 'src/shared/fs/path.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from 'src/platform/settings/settings.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { migrateGlobalMemoryIfNeeded } from 'src/memory/memdir/memoryMigration.js'

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
 */
export function isExtractModeActive(): boolean {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', false)) {
    return false
  }
  return (
    !getIsNonInteractiveSession() ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_thimble', false)
  )
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
const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

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
  // expanded — they would make isAutoMemPath() match all of $HOME or its
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
  // exactly one to match the trailing-sep contract of getAutoMemPath()
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
 * Direct override for the full auto-memory directory path via env var.
 * When set, getAutoMemPath()/getAutoMemEntrypoint() return this path directly
 * instead of computing `{base}/projects/{sanitized-cwd}/memory/`.
 *
 * Used by Cowork to redirect memory to a space-scoped mount where the
 * per-session cwd (which contains the VM process name) would otherwise
 * produce a different project-key for every session.
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
    false,
  )
}

/**
 * Settings.json override for the full auto-memory directory path.
 * Supports ~/ expansion for user convenience.
 *
 * SECURITY: projectSettings (.claudin/settings.json committed to the repo) is
 * intentionally excluded — a malicious repo could otherwise set
 * autoMemoryDirectory: "~/.ssh" and gain silent write access to sensitive
 * directories via the filesystem.ts write carve-out (which fires when
 * isAutoMemPath() matches and hasAutoMemPathOverride() is false). This follows
 * the same pattern as hasSkipDangerousModePermissionPrompt() etc.
 */
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true)
}

/**
 * Check if CLAUDE_COWORK_MEMORY_PATH_OVERRIDE is set to a valid override.
 * Use this as a signal that the SDK caller has explicitly opted into
 * the auto-memory mechanics — e.g. to decide whether to inject the
 * memory prompt when a custom system prompt replaces the default.
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * Whether the project-local auto-memory default (<gitRoot>/.claudin/memory/)
 * is enabled. Defaults to true; set autoMemoryProjectLocal: false to force
 * the legacy global-only location without a rebuild.
 *
 * SECURITY: projectSettings is intentionally excluded, same rationale as
 * getAutoMemPathSetting() above — this setting only changes *where* memory
 * that's already trusted-local gets stored, not an arbitrary path, so the
 * blast radius of a malicious repo forcing it is low, but excluding
 * projectSettings keeps the trust model consistent with the sibling setting.
 */
function isAutoMemProjectLocalEnabled(): boolean {
  const val =
    getSettingsForSource('policySettings')?.autoMemoryProjectLocal ??
    getSettingsForSource('flagSettings')?.autoMemoryProjectLocal ??
    getSettingsForSource('localSettings')?.autoMemoryProjectLocal ??
    getSettingsForSource('userSettings')?.autoMemoryProjectLocal
  return val !== false
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
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
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

    try {
      getFsImplementation().mkdirSync(projectLocalPath, { mode: 0o700 })
    } catch (error) {
      logError(error)
      return legacyPath
    }

    // SECURITY: the memory directory now lives inside the project tree,
    // whose contents an attacker controls if the user opens/clones a hostile
    // repo. mkdirSync above follows existing symlink components lexically,
    // and isAutoMemPath() (below) auto-approves reads/writes under this path
    // with no prompt — so a `.claudin` symlink planted in the repo could
    // otherwise turn auto-memory into an unprompted read/write primitive
    // against an arbitrary location. Verify the real path is still contained
    // in the real git root; fall back to the legacy global dir if the check
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

    migrateGlobalMemoryIfNeeded(legacyPath, projectLocalPath)

    return projectLocalPath
  },
  () => getProjectRoot(),
)

/**
 * Returns the daily log file path for the given date (defaults to today).
 * Shape: <autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 *
 * Used by assistant mode (feature('KAIROS')): rather than maintaining
 * MEMORY.md as a live index, the agent appends to a date-named log file
 * as it works. A separate nightly /dream skill distills these logs into
 * topic files + MEMORY.md.
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * Returns the auto-memory entrypoint (MEMORY.md inside the auto-memory dir).
 * Follows the same resolution order as getAutoMemPath().
 */
export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * Check if an absolute path is within the auto-memory directory.
 *
 * When CLAUDE_COWORK_MEMORY_PATH_OVERRIDE is set, this matches against the
 * env-var override directory. Note that a true return here does NOT imply
 * write permission in that case — the filesystem.ts write carve-out is gated
 * on !hasAutoMemPathOverride() (it exists to bypass DANGEROUS_DIRECTORIES).
 *
 * The settings.json autoMemoryDirectory DOES get the write carve-out: it's the
 * user's explicit choice from a trusted settings source (projectSettings is
 * excluded — see getAutoMemPathSetting), and hasAutoMemPathOverride() remains
 * false for it.
 */
export function isAutoMemPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPath())
}
