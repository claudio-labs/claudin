/**
 * Native Installer Implementation
 *
 * This module implements the file-based native installer system described in
 * docs/native-installer.md. It provides:
 * - Directory structure management with symlinks
 * - Version installation and activation
 * - Multi-process safety with locking
 * - Simple fallback mechanism using modification time
 * - Support for both JS and native builds
 */

import { constants as fsConstants } from 'fs'
import {
  access,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  unlink,
} from 'fs/promises'
import { homedir } from 'os'
import { basename, delimiter, dirname, join, resolve } from 'path'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getCurrentInstallationType } from 'src/platform/doctor/doctorDiagnostic.js'
import { env } from 'src/shared/env.js'
import { envDynamic } from 'src/shared/envDynamic.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'
import { getShellType } from 'src/platform/install/localInstaller.js'
import * as lockfile from 'src/shared/fs/lockfile.js'
import { logError } from 'src/shared/log.js'
import { getShellConfigPaths } from 'src/shared/proc/shellConfig.js'
import { sleep } from 'src/shared/sleep.js'
import {
  getUserBinDir,
  getXDGCacheHome,
  getXDGDataHome,
  getXDGStateHome,
} from 'src/shared/fs/xdg.js'
import {
  acquireProcessLifetimeLock,
  cleanupStaleLocks,
  isLockActive,
  isPidBasedLockingEnabled,
  withLock,
} from 'src/platform/install/pidLock.js'

export const VERSION_RETENTION_COUNT = 2

// 7 days in milliseconds - used for mtime-based lock stale timeout.
// This is long enough to survive laptop sleep durations while still
// allowing cleanup of abandoned locks from crashed processes within a reasonable time.
const LOCK_STALE_MS = 7 * 24 * 60 * 60 * 1000

export type SetupMessage = {
  message: string
  userActionRequired: boolean
  type: 'path' | 'alias' | 'info' | 'error'
}

function getPlatform(): string {
  // Use env.platform which already handles platform detection and defaults to 'linux'
  const os = env.platform

  const arch =
    process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null

  if (!arch) {
    const error = new Error(`Unsupported architecture: ${process.arch}`)
    logForDebugging(
      `Native installer does not support architecture: ${process.arch}`,
      { level: 'error' },
    )
    throw error
  }

  // Check for musl on Linux and adjust platform accordingly
  if (os === 'linux' && envDynamic.isMuslEnvironment()) {
    return `linux-${arch}-musl`
  }

  return `${os}-${arch}`
}

function getBinaryName(platform: string): string {
  return platform.startsWith('win32') ? 'claude.exe' : 'claude'
}

function getBaseDirectories() {
  const platform = getPlatform()
  const executableName = getBinaryName(platform)

  return {
    // Data directories (permanent storage)
    versions: join(getXDGDataHome(), 'claude', 'versions'),

    // Cache directories (can be deleted)
    staging: join(getXDGCacheHome(), 'claude', 'staging'),

    // State directories
    locks: join(getXDGStateHome(), 'claude', 'locks'),

    // User bin
    executable: join(getUserBinDir(), executableName),
  }
}

async function isPossibleClaudeBinary(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath)
    // before download, the version lock file (located at the same filePath) will be size 0
    // also, we allow small sizes because we want to treat small wrapper scripts as valid
    if (!stats.isFile() || stats.size === 0) {
      return false
    }

    // Check if file is executable. Note: On Windows, this relies on file extensions
    // (.exe, .bat, .cmd) and ACL permissions rather than Unix permission bits,
    // so it may not work perfectly for all executable files on Windows.
    await access(filePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

// Execute a callback while holding a lock on a version file
// Returns false if the file is already locked, true if callback executed
async function tryWithVersionLock(
  versionFilePath: string,
  callback: () => void | Promise<void>,
  retries = 0,
): Promise<boolean> {
  const dirs = getBaseDirectories()

  const lockfilePath = getLockFilePathFromVersionPath(dirs, versionFilePath)

  // Ensure the locks directory exists
  await mkdir(dirs.locks, { recursive: true })

  if (isPidBasedLockingEnabled()) {
    // Use PID-based locking with optional retries
    let attempts = 0
    const maxAttempts = retries + 1
    const minTimeout = retries > 0 ? 1000 : 100
    const maxTimeout = retries > 0 ? 5000 : 500

    while (attempts < maxAttempts) {
      const success = await withLock(
        versionFilePath,
        lockfilePath,
        async () => {
          try {
            await callback()
          } catch (error) {
            logError(error)
            throw error
          }
        },
      )

      if (success) {
        return true
      }

      attempts++
      if (attempts < maxAttempts) {
        // Wait before retrying with exponential backoff
        const timeout = Math.min(
          minTimeout * Math.pow(2, attempts - 1),
          maxTimeout,
        )
        await sleep(timeout)
      }
    }

    logLockAcquisitionError(
      versionFilePath,
      new Error('Lock held by another process'),
    )
    return false
  }

  // Use mtime-based locking (proper-lockfile) with 30-day stale timeout
  let release: (() => Promise<void>) | null = null
  try {
    // Lock acquisition phase - catch lock errors and return false
    // Use 30 days for stale to match lockCurrentVersion() - this ensures we never
    // consider a running process's lock as stale during normal usage (including
    // laptop sleep). 30 days allows eventual cleanup of abandoned locks from
    // crashed processes while being long enough for any realistic session.
    try {
      release = await lockfile.lock(versionFilePath, {
        stale: LOCK_STALE_MS,
        retries: {
          retries,
          minTimeout: retries > 0 ? 1000 : 100,
          maxTimeout: retries > 0 ? 5000 : 500,
        },
        lockfilePath,
        // Handle lock compromise gracefully to prevent unhandled rejections
        // This can happen if another process deletes the lock directory while we hold it
        onCompromised: (err: Error) => {
          logForDebugging(
            `NON-FATAL: Version lock was compromised during operation: ${err.message}`,
            { level: 'info' },
          )
        },
      })
    } catch (lockError) {
      logLockAcquisitionError(versionFilePath, lockError)
      return false
    }

    // Operation phase - log errors but let them propagate
    try {
      await callback()
      return true
    } catch (error) {
      logError(error)
      throw error
    }
  } finally {
    if (release) {
      await release()
    }
  }
}

export async function checkInstall(
  force: boolean = false,
): Promise<SetupMessage[]> {
  // Skip all installation checks if disabled via environment variable
  if (isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) {
    return []
  }

  // Get the actual installation type and config
  const installationType = await getCurrentInstallationType()

  // Skip checks for development builds - config.installMethod from a previous
  // native installation shouldn't trigger warnings when running dev builds
  if (installationType === 'development') {
    return []
  }

  const config = getGlobalConfig()

  // Only show warnings if:
  // 1. User is actually running from native installation, OR
  // 2. User has explicitly set installMethod to 'native' in config (they're trying to use native)
  // 3. force is true (used during installation process)
  const shouldCheckNative =
    force || installationType === 'native' || config.installMethod === 'native'

  if (!shouldCheckNative) {
    return []
  }

  const dirs = getBaseDirectories()
  const messages: SetupMessage[] = []
  const localBinDir = dirname(dirs.executable)
  const resolvedLocalBinPath = resolve(localBinDir)
  const platform = getPlatform()
  const isWindows = platform.startsWith('win32')

  // Check if bin directory exists
  try {
    await access(localBinDir)
  } catch {
    messages.push({
      message: `installMethod is native, but directory ${localBinDir} does not exist`,
      userActionRequired: true,
      type: 'error',
    })
  }

  // Check if claude executable exists and is valid.
  // On non-Windows, call readlink directly and route errno — ENOENT means
  // the executable is missing, EINVAL means it exists but isn't a symlink.
  // This avoids an access()→readlink() TOCTOU where deletion between the
  // two calls produces a misleading "Not a symlink" diagnostic.
  // isPossibleClaudeBinary stats the path internally, so we don't pre-check
  // with access() — that would be a TOCTOU between access and the stat.
  if (isWindows) {
    // On Windows it's a copied executable, not a symlink
    if (!(await isPossibleClaudeBinary(dirs.executable))) {
      messages.push({
        message: `installMethod is native, but claude command is missing or invalid at ${dirs.executable}`,
        userActionRequired: true,
        type: 'error',
      })
    }
  } else {
    try {
      const target = await readlink(dirs.executable)
      const absoluteTarget = resolve(dirname(dirs.executable), target)
      if (!(await isPossibleClaudeBinary(absoluteTarget))) {
        messages.push({
          message: `Claude symlink points to missing or invalid binary: ${target}`,
          userActionRequired: true,
          type: 'error',
        })
      }
    } catch (e) {
      if (isENOENT(e)) {
        messages.push({
          message: `installMethod is native, but claude command not found at ${dirs.executable}`,
          userActionRequired: true,
          type: 'error',
        })
      } else {
        // EINVAL (not a symlink) or other — check as regular binary
        if (!(await isPossibleClaudeBinary(dirs.executable))) {
          messages.push({
            message: `${dirs.executable} exists but is not a valid Claude binary`,
            userActionRequired: true,
            type: 'error',
          })
        }
      }
    }
  }

  // Check if bin directory is in PATH
  const isInCurrentPath = (process.env.PATH || '')
    .split(delimiter)
    .some(entry => {
      try {
        const resolvedEntry = resolve(entry)
        // On Windows, perform case-insensitive comparison for paths
        if (isWindows) {
          return (
            resolvedEntry.toLowerCase() === resolvedLocalBinPath.toLowerCase()
          )
        }
        return resolvedEntry === resolvedLocalBinPath
      } catch {
        return false
      }
    })

  if (!isInCurrentPath) {
    if (isWindows) {
      // Windows-specific PATH instructions
      const windowsBinPath = localBinDir.replace(/\//g, '\\')
      messages.push({
        message: `Native installation exists but ${windowsBinPath} is not in your PATH. Add it by opening: System Properties → Environment Variables → Edit User PATH → New → Add the path above. Then restart your terminal.`,
        userActionRequired: true,
        type: 'path',
      })
    } else {
      // Unix-style PATH instructions
      const shellType = getShellType()
      const configPaths = getShellConfigPaths()
      const configFile = configPaths[shellType as keyof typeof configPaths]
      const displayPath = configFile
        ? configFile.replace(homedir(), '~')
        : 'your shell config file'

      messages.push({
        message: `Native installation exists but ~/.local/bin is not in your PATH. Run:\n\necho 'export PATH="$HOME/.local/bin:$PATH"' >> ${displayPath} && source ${displayPath}`,
        userActionRequired: true,
        type: 'path',
      })
    }
  }

  return messages
}

async function getVersionFromSymlink(
  symlinkPath: string,
): Promise<string | null> {
  try {
    const target = await readlink(symlinkPath)
    const absoluteTarget = resolve(dirname(symlinkPath), target)
    if (await isPossibleClaudeBinary(absoluteTarget)) {
      return absoluteTarget
    }
  } catch {
    // Not a symlink / doesn't exist / target doesn't exist
  }
  return null
}

function getLockFilePathFromVersionPath(
  dirs: ReturnType<typeof getBaseDirectories>,
  versionPath: string,
) {
  const versionName = basename(versionPath)
  return join(dirs.locks, `${versionName}.lock`)
}

/**
 * Acquire a lock on the current running version to prevent it from being deleted
 * This lock is held for the entire lifetime of the process
 *
 * Uses PID-based locking (when enabled) which can immediately detect crashed processes
 * (unlike mtime-based locking which requires a 30-day timeout)
 */
export async function lockCurrentVersion(): Promise<void> {
  const dirs = getBaseDirectories()

  // Only lock if we're running from the versions directory
  if (!process.execPath.includes(dirs.versions)) {
    return
  }

  const versionPath = resolve(process.execPath)
  try {
    const lockfilePath = getLockFilePathFromVersionPath(dirs, versionPath)

    // Ensure locks directory exists
    await mkdir(dirs.locks, { recursive: true })

    if (isPidBasedLockingEnabled()) {
      // Acquire PID-based lock and hold it for the process lifetime
      // PID-based locking allows immediate detection of crashed processes
      // while still surviving laptop sleep (process is suspended but PID exists)
      const acquired = await acquireProcessLifetimeLock(
        versionPath,
        lockfilePath,
      )

      if (!acquired) {
        logLockAcquisitionError(
          versionPath,
          new Error('Lock already held by another process'),
        )
        return
      }

      logForDebugging(`Acquired PID lock on running version: ${versionPath}`)
    } else {
      // Acquire mtime-based lock and never release it (until process exits)
      // Use 30 days for stale to prevent the lock from being considered stale during
      // normal usage. This is critical because laptop sleep suspends the process,
      // stopping the mtime heartbeat. 30 days is long enough for any realistic session
      // while still allowing eventual cleanup of abandoned locks.
      let release: (() => Promise<void>) | undefined
      try {
        release = await lockfile.lock(versionPath, {
          stale: LOCK_STALE_MS,
          retries: 0, // Don't retry - if we can't lock, that's fine
          lockfilePath,
          // Handle lock compromise gracefully (e.g., if another process deletes the lock directory)
          onCompromised: (err: Error) => {
            logForDebugging(
              `NON-FATAL: Lock on running version was compromised: ${err.message}`,
              { level: 'info' },
            )
          },
        })
        logForDebugging(
          `Acquired mtime-based lock on running version: ${versionPath}`,
        )

        // Release lock explicitly; proper-lockfile's cleanup is unreliable with signal-exit v3+v4
        registerCleanup(async () => {
          try {
            await release?.()
          } catch {
            // Lock may already be released
          }
        })
      } catch (lockError) {
        if (isENOENT(lockError)) {
          logForDebugging(
            `Cannot lock current version - file does not exist: ${versionPath}`,
            { level: 'info' },
          )
          return
        }
        logLockAcquisitionError(versionPath, lockError)
        return
      }
    }
  } catch (error) {
    if (isENOENT(error)) {
      logForDebugging(
        `Cannot lock current version - file does not exist: ${versionPath}`,
        { level: 'info' },
      )
      return
    }
    // We fallback to previous behavior where we don't acquire a lock on a running version
    // This ~mostly works but using native binaries like ripgrep will fail
    logForDebugging(
      `NON-FATAL: Failed to lock current version during execution ${errorMessage(error)}`,
      { level: 'info' },
    )
  }
}

function logLockAcquisitionError(versionPath: string, lockError: unknown) {
  logError(
    new Error(
      `NON-FATAL: Lock acquisition failed for ${versionPath} (expected in multi-process scenarios)`,
      { cause: lockError },
    ),
  )
}

export async function cleanupOldVersions(): Promise<void> {
  // Yield to ensure we don't block startup
  await Promise.resolve()

  const dirs = getBaseDirectories()
  const oneHourAgo = Date.now() - 3600000

  // Clean up old renamed executables on Windows (no longer running at startup)
  if (getPlatform().startsWith('win32')) {
    const executableDir = dirname(dirs.executable)
    try {
      const files = await readdir(executableDir)
      let cleanedCount = 0
      for (const file of files) {
        if (!/^claude\.exe\.old\.\d+$/.test(file)) continue
        try {
          await unlink(join(executableDir, file))
          cleanedCount++
        } catch {
          // File might still be in use by another process
        }
      }
      if (cleanedCount > 0) {
        logForDebugging(
          `Cleaned up ${cleanedCount} old Windows executables on startup`,
        )
      }
    } catch (error) {
      if (!isENOENT(error)) {
        logForDebugging(`Failed to clean up old Windows executables: ${error}`)
      }
    }
  }

  // Clean up orphaned staging directories older than 1 hour
  try {
    const stagingEntries = await readdir(dirs.staging)
    let stagingCleanedCount = 0
    for (const entry of stagingEntries) {
      const stagingPath = join(dirs.staging, entry)
      try {
        // stat() is load-bearing here (we need mtime). There is a theoretical
        // TOCTOU where a concurrent installer could freshen a stale staging
        // dir between stat and rm — but the 1-hour threshold makes this
        // vanishingly unlikely, and rm({force:true}) tolerates concurrent
        // deletion.
        const stats = await stat(stagingPath)
        if (stats.mtime.getTime() < oneHourAgo) {
          await rm(stagingPath, { recursive: true, force: true })
          stagingCleanedCount++
          logForDebugging(`Cleaned up old staging directory: ${entry}`)
        }
      } catch {
        // Ignore individual errors
      }
    }
    if (stagingCleanedCount > 0) {
      logForDebugging(
        `Cleaned up ${stagingCleanedCount} orphaned staging directories`,
      )
    }
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Failed to clean up staging directories: ${error}`)
    }
  }

  // Clean up stale PID locks (crashed processes) — cleanupStaleLocks handles ENOENT
  if (isPidBasedLockingEnabled()) {
    const staleLocksCleaned = cleanupStaleLocks(dirs.locks)
    if (staleLocksCleaned > 0) {
      logForDebugging(`Cleaned up ${staleLocksCleaned} stale version locks`)
    }
  }

  // Single readdir of versions dir. Partition into temp files vs candidate binaries,
  // stat'ing each entry at most once.
  let versionEntries: string[]
  try {
    versionEntries = await readdir(dirs.versions)
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Failed to readdir versions directory: ${error}`)
    }
    return
  }

  type VersionInfo = {
    name: string
    path: string
    resolvedPath: string
    mtime: Date
  }
  const versionFiles: VersionInfo[] = []
  let tempFilesCleanedCount = 0

  for (const entry of versionEntries) {
    const entryPath = join(dirs.versions, entry)
    if (/\.tmp\.\d+\.\d+$/.test(entry)) {
      // Orphaned temp install file — pattern: {version}.tmp.{pid}.{timestamp}
      try {
        const stats = await stat(entryPath)
        if (stats.mtime.getTime() < oneHourAgo) {
          await unlink(entryPath)
          tempFilesCleanedCount++
          logForDebugging(`Cleaned up orphaned temp install file: ${entry}`)
        }
      } catch {
        // Ignore individual errors
      }
      continue
    }
    // Candidate version binary — stat once, reuse for isFile/size/mtime/mode
    try {
      const stats = await stat(entryPath)
      if (!stats.isFile()) continue
      if (
        process.platform !== 'win32' &&
        stats.size > 0 &&
        (stats.mode & 0o111) === 0
      ) {
        // Check executability via mode bits from the existing stat result —
        // avoids a second syscall (access(X_OK)) and the TOCTOU window between
        // stat and access. Skip on Windows: libuv only sets execute bits for
        // .exe/.com/.bat/.cmd, but version files are extensionless semver
        // strings (e.g. "1.2.3"), so this check would reject all of them.
        // The previous access(X_OK) passed any readable file on Windows anyway.
        continue
      }
      versionFiles.push({
        name: entry,
        path: entryPath,
        resolvedPath: resolve(entryPath),
        mtime: stats.mtime,
      })
    } catch {
      // Skip files we can't stat
    }
  }

  if (tempFilesCleanedCount > 0) {
    logForDebugging(
      `Cleaned up ${tempFilesCleanedCount} orphaned temp install files`,
    )
  }

  if (versionFiles.length === 0) {
    return
  }

  try {
    // Identify protected versions
    const currentBinaryPath = process.execPath
    const protectedVersions = new Set<string>()
    if (currentBinaryPath && currentBinaryPath.includes(dirs.versions)) {
      protectedVersions.add(resolve(currentBinaryPath))
    }

    const currentSymlinkVersion = await getVersionFromSymlink(dirs.executable)
    if (currentSymlinkVersion) {
      protectedVersions.add(currentSymlinkVersion)
    }

    // Protect versions with active locks (running in other processes)
    for (const v of versionFiles) {
      if (protectedVersions.has(v.resolvedPath)) continue

      const lockFilePath = getLockFilePathFromVersionPath(dirs, v.resolvedPath)
      let hasActiveLock = false
      if (isPidBasedLockingEnabled()) {
        hasActiveLock = isLockActive(lockFilePath)
      } else {
        try {
          hasActiveLock = await lockfile.check(v.resolvedPath, {
            stale: LOCK_STALE_MS,
            lockfilePath: lockFilePath,
          })
        } catch {
          hasActiveLock = false
        }
      }
      if (hasActiveLock) {
        protectedVersions.add(v.resolvedPath)
        logForDebugging(`Protecting locked version from cleanup: ${v.name}`)
      }
    }

    // Eligible versions: not protected, sorted newest first (reuse cached mtime)
    const eligibleVersions = versionFiles
      .filter(v => !protectedVersions.has(v.resolvedPath))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    const versionsToDelete = eligibleVersions.slice(VERSION_RETENTION_COUNT)

    if (versionsToDelete.length === 0) {
      return
    }

    let deletedCount = 0
    let lockFailedCount = 0
    let errorCount = 0

    await Promise.all(
      versionsToDelete.map(async version => {
        try {
          const deleted = await tryWithVersionLock(version.path, async () => {
            await unlink(version.path)
          })
          if (deleted) {
            deletedCount++
          } else {
            lockFailedCount++
            logForDebugging(
              `Skipping deletion of ${version.name} - locked by another process`,
            )
          }
        } catch (error) {
          errorCount++
          logError(
            new Error(`Failed to delete version ${version.name}: ${error}`),
          )
        }
      }),
    )

  } catch (error) {
    if (!isENOENT(error)) {
      logError(new Error(`Version cleanup failed: ${error}`))
    }
  }
}

/**
 * Check if a given path is managed by npm
 * @param executablePath - The path to check (can be a symlink)
 * @returns true if the path is npm-managed, false otherwise
 */
async function isNpmSymlink(executablePath: string): Promise<boolean> {
  // Resolve symlink to its target if applicable
  let targetPath = executablePath
  const stats = await lstat(executablePath)
  if (stats.isSymbolicLink()) {
    targetPath = await realpath(executablePath)
  }

  // checking npm prefix isn't guaranteed to work, as prefix can change
  // and users may set --prefix manually when installing
  // thus we use this heuristic:
  return targetPath.endsWith('.js') || targetPath.includes('node_modules')
}

/**
 * Remove the claude symlink from the executable directory
 * This is used when switching away from native installation
 * Will only remove if it's a native binary symlink, not npm-managed JS files
 */
export async function removeInstalledSymlink(): Promise<void> {
  const dirs = getBaseDirectories()

  try {
    // Check if this is an npm-managed installation
    if (await isNpmSymlink(dirs.executable)) {
      logForDebugging(
        `Skipping removal of ${dirs.executable} - appears to be npm-managed`,
      )
      return
    }

    // It's a native binary symlink, safe to remove
    await unlink(dirs.executable)
    logForDebugging(`Removed claude symlink at ${dirs.executable}`)
  } catch (error) {
    if (isENOENT(error)) {
      return
    }
    logError(new Error(`Failed to remove claude symlink: ${error}`))
  }
}
