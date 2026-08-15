import { constants as fsConstants } from 'fs'
import { access, readFile, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getLauncherPath } from 'src/services/install/bundledMode.js'
import { type ReleaseChannel, saveGlobalConfig } from 'src/services/config/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { env } from 'src/utils/env.js'
import { getClaudinConfigHomeDir } from 'src/utils/envUtils.js'
import { ClaudeError, getErrnoCode, isENOENT } from 'src/utils/errors.js'
import { execFileNoThrowWithCwd } from 'src/utils/proc/execFileNoThrow.js'
import { getFsImplementation } from 'src/utils/fs/fsOperations.js'
import { logError } from 'src/utils/log.js'
import { getPlatform } from 'src/utils/proc/platform.js'
import { gte } from 'src/utils/semver.js'
import { getInitialSettings } from 'src/services/settings/settings.js'
import {
  filterClaudeAliases,
  getShellConfigPaths,
  readFileLines,
  writeFileLines,
} from 'src/utils/proc/shellConfig.js'
import { jsonParse } from 'src/utils/slowOperations.js'

class AutoUpdaterError extends ClaudeError {}

type PackageManager = 'npm' | 'bun'

/**
 * Detect a Bun global install from where the launcher actually lives.
 *
 * Location, not runtime: `bin/claudin` may re-exec into Node for the heap bump,
 * and conversely the release binaries are bun-compiled so they always report a
 * Bun runtime. Only the install path says which package manager owns us.
 */
function isInstalledViaBun(): boolean {
  const invokedPath = getLauncherPath()
  if (invokedPath.includes('/.bun/install/global/')) return true
  const bunInstall = process.env.BUN_INSTALL
  if (bunInstall && invokedPath.startsWith(bunInstall)) return true
  return false
}

/**
 * Which package manager owns THIS installation.
 *
 * Deliberately NOT `isRunningWithBun()`. Every Claudin release binary is
 * bun-compiled, so `process.versions.bun` is always defined — using it made the
 * updater run `bun install -g` even for npm installs, which either failed
 * outright (no `bun` on PATH → `bun pm bin -g` fails → a bogus "insufficient
 * permissions, try sudo") or quietly built a second, competing global tree
 * while the npm copy on PATH stayed at the old version.
 */
function getInstallPackageManager(): PackageManager {
  return isInstalledViaBun() ? 'bun' : 'npm'
}

// The wrapper package ships bin/claudin.exe as a ~600-byte Node stub that its
// postinstall (install.cjs) hardlinks the native binary over. Anything under
// this size is still the stub (the native binary is ~200MB), so the postinstall
// has not run.
const STUB_LAUNCHER_MAX_BYTES = 4096

// spawn() surfaces a missing executable as an "spawn <cmd> ENOENT" error message.
const SPAWN_ENOENT_RE = /ENOENT/i

export function getBunGlobalPackageDir(): string {
  const root = process.env.BUN_INSTALL || join(homedir(), '.bun')
  return join(
    root,
    'install',
    'global',
    'node_modules',
    MACRO.PACKAGE_URL as string,
  )
}

async function getNpmGlobalPackageDir(): Promise<string | null> {
  // Run from home directory to avoid reading project-level .npmrc.
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['-g', 'config', 'get', 'prefix'],
    { cwd: homedir() },
  )
  if (result.code !== 0) return null
  const prefix = result.stdout.trim()
  if (!prefix) return null
  return getPlatform() === 'windows'
    ? join(prefix, 'node_modules', MACRO.PACKAGE_URL as string)
    : join(prefix, 'lib', 'node_modules', MACRO.PACKAGE_URL as string)
}

/** Version recorded in an installed package dir, or null when not installed. */
async function readInstalledVersion(
  packageDir: string,
): Promise<string | null> {
  try {
    const raw = await readFile(join(packageDir, 'package.json'), 'utf8')
    const parsed = jsonParse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch (e) {
    if (!isENOENT(e)) logError(e as Error)
    return null
  }
}

function getGlobalPackageDir(pm: PackageManager): Promise<string | null> {
  return pm === 'bun'
    ? Promise.resolve(getBunGlobalPackageDir())
    : getNpmGlobalPackageDir()
}

/**
 * Refresh the OTHER global tree when it still holds an older copy.
 *
 * npm and bun keep independent global prefixes, and PATH — not the updater —
 * decides which binary the OS ends up running. Updating only the tree we were
 * launched from leaves the stale one shadowing us, which the user experiences
 * as "the update did nothing". Reports one line and never fails the update.
 */
async function repairStaleSiblingInstall(
  primary: PackageManager,
  packageSpec: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  const sibling: PackageManager = primary === 'npm' ? 'bun' : 'npm'

  const siblingDir = await getGlobalPackageDir(sibling)
  if (!siblingDir) return
  const siblingVersion = await readInstalledVersion(siblingDir)
  if (!siblingVersion) return // nothing installed there — nothing to shadow us

  const primaryDir = await getGlobalPackageDir(primary)
  const primaryVersion = primaryDir
    ? await readInstalledVersion(primaryDir)
    : null
  if (primaryVersion && siblingVersion === primaryVersion) return

  logForDebugging(
    `update: repairing stale ${sibling} install ${siblingVersion} at ${siblingDir}`,
  )

  const args =
    sibling === 'npm'
      ? ['install', '-g', '--force', packageSpec]
      : ['install', '-g', packageSpec]
  const result = await execFileNoThrowWithCwd(sibling, args, { cwd: homedir() })
  if (result.code !== 0) {
    // The sibling manager may not even be installed. Nothing the user has to
    // act on — the tree they launched from is updated either way.
    logError(
      new AutoUpdaterError(
        `Failed to refresh the ${sibling} global install at ${siblingDir}: ${result.stdout} ${result.stderr}`,
      ),
    )
    return
  }

  // `bun install -g` skips postinstall, leaving the Node stub in place.
  if (sibling === 'bun') await repairBunGlobalBinary()

  // Reported only once the repair actually landed, so the line never claims
  // work that failed.
  onProgress?.(`Repaired old version ${siblingVersion} at ${siblingDir}`)
}

/**
 * Run the wrapper package's postinstall (`install.cjs`) that Bun skipped.
 *
 * The script declares `node` as its runtime (`#!/usr/bin/env node`, and the
 * package's own `postinstall` is `node install.cjs`), so prefer `node`. Fall
 * back to `bun` only when node isn't on PATH — bun is guaranteed present on a
 * Bun global install and runs the CJS script fine. Returns true on exit 0.
 */
async function runSkippedPostinstall(
  installScript: string,
  cwd: string,
): Promise<boolean> {
  const node = await execFileNoThrowWithCwd('node', [installScript], { cwd })
  if (node.code === 0) return true

  // A non-ENOENT failure means node ran but the postinstall itself failed —
  // that's the authoritative result; don't paper over it by retrying with bun.
  if (!SPAWN_ENOENT_RE.test(node.error ?? '')) {
    logError(
      new AutoUpdaterError(
        `Skipped postinstall failed under node: ${node.stdout} ${node.stderr}`,
      ),
    )
    return false
  }

  // node isn't installed — fall back to bun.
  const bun = await execFileNoThrowWithCwd('bun', [installScript], { cwd })
  if (bun.code === 0) return true
  logError(
    new AutoUpdaterError(
      `Skipped postinstall failed under bun: ${bun.stdout} ${bun.stderr}`,
    ),
  )
  return false
}

/**
 * Repair a Bun global install whose postinstall was skipped.
 *
 * `bun install -g` does not run lifecycle scripts (postinstall) by default, so
 * the wrapper package's `bin/claudin.exe` is left as the Node stub instead of
 * the native binary that its postinstall (`install.cjs`) hardlinks into place.
 * Running the stub then fails hard: Node's ESM loader rejects the `.exe`
 * extension (ERR_UNKNOWN_FILE_EXTENSION). This runs the skipped postinstall to
 * place the native binary. No-op when there is no Bun global install, the
 * wrapper layout isn't present, or the binary is already in place.
 *
 * Returns true only when a repair was actually performed.
 */
export async function repairBunGlobalBinary(): Promise<boolean> {
  const pkgDir = getBunGlobalPackageDir()
  const installScript = join(pkgDir, 'install.cjs')
  const launcher = join(pkgDir, 'bin', 'claudin.exe')

  // The whole gate is this cheap fs check: only a Bun global install of the
  // native-binary wrapper has install.cjs at this path. When it's absent (npm
  // installs, no Bun global) we bail without spawning any subprocess.
  try {
    await access(installScript, fsConstants.F_OK)
  } catch (e) {
    if (!isENOENT(e)) logError(e as Error)
    return false
  }

  // If the launcher is already the native binary (large), postinstall ran.
  try {
    const info = await stat(launcher)
    if (info.size > STUB_LAUNCHER_MAX_BYTES) return false
  } catch (e) {
    // ENOENT: launcher missing entirely — let the postinstall recreate it.
    if (!isENOENT(e)) {
      logError(e as Error)
      return false
    }
  }

  // Bun skipped the postinstall; run it now.
  if (!(await runSkippedPostinstall(installScript, pkgDir))) return false
  logForDebugging('update: repaired Bun global launcher via install.cjs')
  return true
}

export type InstallStatus =
  | 'success'
  | 'no_permissions'
  | 'install_failed'
  | 'in_progress'

export type AutoUpdaterResult = {
  version: string | null
  status: InstallStatus
  notifications?: string[]
}

export type MaxVersionConfig = {
  external?: string
  ant?: string
  external_message?: string
  ant_message?: string
}

/**
 * Checks if the current version meets the minimum required version from Statsig config
 * Terminates the process with an error message if the version is too old
 *
 * NOTE ON SHA-BASED VERSIONING:
 * We use SemVer-compliant versioning with build metadata format (X.X.X+SHA) for continuous deployment.
 * According to SemVer specs, build metadata (the +SHA part) is ignored when comparing versions.
 *
 * Versioning approach:
 * 1. For version requirements/compatibility (assertMinVersion), we use semver comparison that ignores build metadata
 * 2. For updates ('claude update'), we use exact string comparison to detect any change, including SHA
 *    - This ensures users always get the latest build, even when only the SHA changes
 *    - The UI clearly shows both versions including build metadata
 *
 * This approach keeps version comparison logic simple while maintaining traceability via the SHA.
 */
export async function assertMinVersion(): Promise<void> {
  // Claudin: the upstream min-version kill-switch is Anthropic-specific
  // (gated by their Growthbook tenant). Neutralized for multi-provider builds.
}

/**
 * Returns the maximum allowed version for the current user type.
 * For ants, returns the `ant` field (dev version format).
 * For external users, returns the `external` field (clean semver).
 * This is used as a server-side kill switch to pause auto-updates during incidents.
 * Returns undefined if no cap is configured.
 */
// Claudin: max-version kill-switch is Anthropic-specific (Growthbook tenant).
// Neutralized — no cap is ever applied in open builds.
export async function getMaxVersion(): Promise<string | undefined> {
  return undefined
}

export async function getMaxVersionMessage(): Promise<string | undefined> {
  return undefined
}

/**
 * Checks if a target version should be skipped due to user's minimumVersion setting.
 * This is used when switching to stable channel - the user can choose to stay on their
 * current version until stable catches up, preventing downgrades.
 */
export function shouldSkipVersion(targetVersion: string): boolean {
  const settings = getInitialSettings()
  const minimumVersion = settings?.minimumVersion
  if (!minimumVersion) {
    return false
  }
  // Skip if target version is less than minimum
  const shouldSkip = !gte(targetVersion, minimumVersion)
  if (shouldSkip) {
    logForDebugging(
      `Skipping update to ${targetVersion} - below minimumVersion ${minimumVersion}`,
    )
  }
  return shouldSkip
}

// Lock file for auto-updater to prevent concurrent updates
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minute timeout for locks

/**
 * Get the path to the lock file
 * This is a function to ensure it's evaluated at runtime after test setup
 */
export function getLockFilePath(): string {
  return join(getClaudinConfigHomeDir(), '.update.lock')
}

/**
 * Attempts to acquire a lock for auto-updater
 * @returns true if lock was acquired, false if another process holds the lock
 */
async function acquireLock(): Promise<boolean> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()

  // Check for existing lock: 1 stat() on the happy path (fresh lock or ENOENT),
  // 2 on stale-lock recovery (re-verify staleness immediately before unlink).
  try {
    const stats = await fs.stat(lockPath)
    const age = Date.now() - stats.mtimeMs
    if (age < LOCK_TIMEOUT_MS) {
      return false
    }
    // Lock is stale, remove it before taking over. Re-verify staleness
    // immediately before unlinking to close a TOCTOU race: if two processes
    // both observe the stale lock, A unlinks + writes a fresh lock, then B
    // would unlink A's fresh lock and both believe they hold it. A fresh
    // lock has a recent mtime, so re-checking staleness makes B back off.
    try {
      const recheck = await fs.stat(lockPath)
      if (Date.now() - recheck.mtimeMs < LOCK_TIMEOUT_MS) {
        return false
      }
      await fs.unlink(lockPath)
    } catch (err) {
      if (!isENOENT(err)) {
        logError(err as Error)
        return false
      }
    }
  } catch (err) {
    if (!isENOENT(err)) {
      logError(err as Error)
      return false
    }
    // ENOENT: no lock file, proceed to create one
  }

  // Create lock file atomically with O_EXCL (flag: 'wx'). If another process
  // wins the race and creates it first, we get EEXIST and back off.
  // Lazy-mkdir the config dir on ENOENT.
  try {
    await writeFile(lockPath, `${process.pid}`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return true
  } catch (err) {
    const code = getErrnoCode(err)
    if (code === 'EEXIST') {
      return false
    }
    if (code === 'ENOENT') {
      try {
        // fs.mkdir from getFsImplementation() is always recursive:true and
        // swallows EEXIST internally, so a dir-creation race cannot reach the
        // catch below — only writeFile's EEXIST (true lock contention) can.
        await fs.mkdir(getClaudinConfigHomeDir())
        await writeFile(lockPath, `${process.pid}`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        return true
      } catch (mkdirErr) {
        if (getErrnoCode(mkdirErr) === 'EEXIST') {
          return false
        }
        logError(mkdirErr as Error)
        return false
      }
    }
    logError(err as Error)
    return false
  }
}

/**
 * Releases the update lock if it's held by this process
 */
async function releaseLock(): Promise<void> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()
  try {
    const lockData = await fs.readFile(lockPath, { encoding: 'utf8' })
    if (lockData === `${process.pid}`) {
      await fs.unlink(lockPath)
    }
  } catch (err) {
    if (isENOENT(err)) {
      return
    }
    logError(err as Error)
  }
}

async function getInstallationPrefix(): Promise<string | null> {
  // Run from home directory to avoid reading project-level .npmrc/.bunfig.toml
  const isBun = getInstallPackageManager() === 'bun'
  let prefixResult = null
  if (isBun) {
    prefixResult = await execFileNoThrowWithCwd('bun', ['pm', 'bin', '-g'], {
      cwd: homedir(),
    })
  } else {
    prefixResult = await execFileNoThrowWithCwd(
      'npm',
      ['-g', 'config', 'get', 'prefix'],
      { cwd: homedir() },
    )
  }
  if (prefixResult.code !== 0) {
    logError(new Error(`Failed to check ${isBun ? 'bun' : 'npm'} permissions`))
    return null
  }
  return prefixResult.stdout.trim()
}

export async function checkGlobalInstallPermissions(): Promise<{
  hasPermissions: boolean
  npmPrefix: string | null
}> {
  try {
    const prefix = await getInstallationPrefix()
    if (!prefix) {
      return { hasPermissions: false, npmPrefix: null }
    }

    try {
      await access(prefix, fsConstants.W_OK)
      return { hasPermissions: true, npmPrefix: prefix }
    } catch {
      logError(
        new AutoUpdaterError(
          'Insufficient permissions for global npm install.',
        ),
      )
      return { hasPermissions: false, npmPrefix: prefix }
    }
  } catch (error) {
    logError(error as Error)
    return { hasPermissions: false, npmPrefix: null }
  }
}

export async function getLatestVersion(
  channel: ReleaseChannel,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  const npmTag = channel === 'stable' ? 'stable' : 'latest'
  const timeoutMs = options.timeoutMs ?? 5000

  // Run from home directory to avoid reading project-level .npmrc
  // which could be maliciously crafted to redirect to an attacker's registry
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', `${MACRO.PACKAGE_URL}@${npmTag}`, 'version', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(timeoutMs), cwd: homedir() },
  )
  if (result.code !== 0) {
    logForDebugging(`npm view failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    } else {
      logForDebugging('npm stderr: (empty)')
    }
    if (result.stdout) {
      logForDebugging(`npm stdout: ${result.stdout.trim()}`)
    }
    return null
  }
  return result.stdout.trim()
}

export type NpmDistTags = {
  latest: string | null
  stable: string | null
}

/**
 * Get npm dist-tags (latest and stable versions) from the registry.
 * This is used by the doctor command to show users what versions are available.
 */
export async function getNpmDistTags(): Promise<NpmDistTags> {
  // Run from home directory to avoid reading project-level .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', MACRO.PACKAGE_URL, 'dist-tags', '--json', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view dist-tags failed with code ${result.code}`)
    return { latest: null, stable: null }
  }

  try {
    const parsed = jsonParse(result.stdout.trim()) as Record<string, unknown>
    return {
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      stable: typeof parsed.stable === 'string' ? parsed.stable : null,
    }
  } catch (error) {
    logForDebugging(`Failed to parse dist-tags: ${error}`)
    return { latest: null, stable: null }
  }
}

// Claudin: GCS endpoints below pointed at Anthropic-owned distribution infra.
// Neutralized so the native installer path never phones home — callers
// already treat null as "no GCS info available".
export async function getLatestVersionFromGcs(
  _channel: ReleaseChannel,
): Promise<string | null> {
  return null
}

export async function getGcsDistTags(): Promise<NpmDistTags> {
  return { latest: null, stable: null }
}

/**
 * Get version history from npm registry (internal-only feature)
 * Returns versions sorted newest-first, limited to the specified count
 *
 * Uses NATIVE_PACKAGE_URL when available because:
 * 1. Native installation is the primary installation method for ant users
 * 2. Not all JS package versions have corresponding native packages
 * 3. This prevents rollback from listing versions that don't have native binaries
 */
export async function getVersionHistory(limit: number): Promise<string[]> {
  // Use native package URL when available to ensure we only show versions
  // that have native binaries (not all JS package versions have native builds)
  const packageUrl = MACRO.NATIVE_PACKAGE_URL ?? MACRO.PACKAGE_URL

  // Run from home directory to avoid reading project-level .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', packageUrl, 'versions', '--json', '--prefer-online'],
    // Longer timeout for version list
    { abortSignal: AbortSignal.timeout(30000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view versions failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    }
    return []
  }

  try {
    const versions = jsonParse(result.stdout.trim()) as string[]
    // Take last N versions, then reverse to get newest first
    return versions.slice(-limit).reverse()
  } catch (error) {
    logForDebugging(`Failed to parse version history: ${error}`)
    return []
  }
}

export async function installGlobalPackage(
  specificVersion?: string | null,
  options?: { onProgress?: (message: string) => void },
): Promise<InstallStatus> {
  if (!(await acquireLock())) {
    logError(
      new AutoUpdaterError('Another process is currently installing an update'),
    )
    // Log the lock contention
    logEvent('tengu_auto_updater_lock_contention', {
      pid: process.pid,
      currentVersion:
        MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return 'in_progress'
  }

  try {
    await removeClaudeAliasesFromShellConfigs()
    const packageManager = getInstallPackageManager()

    // Check if we're using npm from Windows path in WSL
    if (packageManager === 'npm' && env.isNpmFromWindowsPath()) {
      logError(new Error('Windows NPM detected in WSL environment'))
      logEvent('tengu_auto_updater_windows_npm_in_wsl', {
        currentVersion:
          MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`
Error: Windows NPM detected in WSL

You're running Claude Code in WSL but using the Windows NPM installation from /mnt/c/.
This configuration is not supported for updates.

To fix this issue:
  1. Install Node.js within your Linux distribution: e.g. sudo apt install nodejs npm
  2. Make sure Linux NPM is in your PATH before the Windows version
  3. Try updating again with 'claude update'
`)
      return 'install_failed'
    }

    const { hasPermissions } = await checkGlobalInstallPermissions()
    if (!hasPermissions) {
      return 'no_permissions'
    }

    // Use specific version if provided, otherwise use latest
    const packageSpec = specificVersion
      ? `${MACRO.PACKAGE_URL}@${specificVersion}`
      : MACRO.PACKAGE_URL

    // Run from home directory to avoid reading project-level .npmrc/.bunfig.toml
    // which could be maliciously crafted to redirect to an attacker's registry
    const installArgs =
      packageManager === 'npm'
        ? ['install', '-g', '--force', packageSpec]
        : ['install', '-g', packageSpec]
    const installResult = await execFileNoThrowWithCwd(
      packageManager,
      installArgs,
      { cwd: homedir() },
    )
    if (installResult.code !== 0) {
      const error = new AutoUpdaterError(
        `Failed to install new version of claude: ${installResult.stdout} ${installResult.stderr}`,
      )
      logError(error)
      return 'install_failed'
    }

    // Bun skips the postinstall on `bun install -g`, leaving the native launcher
    // as a Node stub that fails to run. Run the skipped postinstall now (no-op
    // for npm-only installs).
    await repairBunGlobalBinary()

    // An older copy left in the other global tree can still win the PATH race.
    await repairStaleSiblingInstall(
      packageManager,
      packageSpec as string,
      options?.onProgress,
    )

    // Set installMethod to 'global' to track npm global installations
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'global',
    }))

    return 'success'
  } finally {
    // Ensure we always release the lock
    await releaseLock()
  }
}

/**
 * Remove claude aliases from shell configuration files
 * This helps clean up old installation methods when switching to native or npm global
 */
async function removeClaudeAliasesFromShellConfigs(): Promise<void> {
  const configMap = getShellConfigPaths()

  // Process each shell config file
  for (const [, configFile] of Object.entries(configMap)) {
    try {
      const lines = await readFileLines(configFile)
      if (!lines) continue

      const { filtered, hadAlias } = filterClaudeAliases(lines)

      if (hadAlias) {
        await writeFileLines(configFile, filtered)
        logForDebugging(`Removed claude alias from ${configFile}`)
      }
    } catch (error) {
      // Don't fail the whole operation if one file can't be processed
      logForDebugging(`Failed to remove alias from ${configFile}: ${error}`, {
        level: 'error',
      })
    }
  }
}
