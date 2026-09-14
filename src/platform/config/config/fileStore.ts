/**
 * Config file store — the on-disk half of the config module: the locked and
 * unlocked writers, the timestamped backup/recovery walk, and the reader
 * everything else goes through.
 *
 * Two module vars live here rather than beside the global-config cache that
 * mostly writes them. `lastReadFileStats` is written by the cache (a cold
 * read, a write-through, the freshness watcher) but its only reader is
 * `saveConfigWithLock`'s stale-write check below, so the cache side sets it
 * through `setLastReadFileStats`. `globalConfigWriteCount` is incremented by
 * both writers in this file and only read by the accessor. Declaring either
 * one on the cache side would split it in two: this side would read a value
 * nobody updates, and the counter the UI shows would stop at zero.
 *
 * `wouldLoseAuthState` comes from the global-config side, which imports this
 * module back. The cycle is safe because both ends are hoisted `function`
 * declarations reached at call time — nothing here runs at module init.
 */
import { basename, dirname, join } from 'path'
import pickBy from 'lodash-es/pickBy.js'
import { logEvent } from 'src/platform/analytics/index.js'
import { createDefaultGlobalConfig } from 'src/platform/config/config/defaults.js'
import { wouldLoseAuthState } from 'src/platform/config/config/globalConfig.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { ConfigParseError, getErrnoCode } from 'src/shared/errors.js'
import { writeFileSyncAndFlush } from 'src/shared/fs/file.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { stripBOM } from 'src/shared/data/jsonRead.js'
import * as lockfile from 'src/shared/fs/lockfile.js'
import { logError } from 'src/shared/log.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

// Re-entrancy guard: prevents getConfig → logEvent → getGlobalConfig → getConfig
// infinite recursion when the config file is corrupted. logEvent's sampling check
// reads GrowthBook features from the global config, which calls getConfig again.
let insideGetConfig = false

let lastReadFileStats: { mtime: number; size: number } | null = null

// Session-total count of actual disk writes to the global config file.
// Exposed for internal-only dev diagnostics (see inc-4552) so anomalous write
// rates surface in the UI before they corrupt ~/.claudin/config.json.
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export function setLastReadFileStats(
  stats: { mtime: number; size: number } | null,
): void {
  lastReadFileStats = stats
}

export function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // Ensure the directory exists before writing the config file
  const dir = dirname(file)
  const fs = getFsImplementation()
  // mkdirSync is already recursive in FsOperations implementation
  fs.mkdirSync(dir)

  // Filter out any values that match the defaults
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // Write config file with secure permissions - mode only applies to new files
  writeFileSyncAndFlush(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  if (file === getGlobalClaudeFile()) {
    globalConfigWriteCount++
  }
}

/**
 * Returns true if a write was performed; false if the write was skipped
 * (no changes, or auth-loss guard tripped). Callers use this to decide
 * whether to invalidate the cache -- invalidating after a skipped write
 * destroys the good cached state the auth-loss guard depends on.
 */
export function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // Ensure directory exists (mkdirSync is already recursive in FsOperations)
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: err => {
        // Default onCompromised throws from a setTimeout callback, which
        // becomes an unhandled exception. Log instead -- the lock being
        // stolen (e.g. after a 10s event-loop stall) is recoverable.
        logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Claude instance may be running',
      )
      logEvent('tengu_config_lock_contention', {
        lock_time_ms: lockTime,
      })
    }

    // Check for stale write - file changed since we last read it
    // Only check for global config file since lastReadFileStats tracks that specific file
    if (lastReadFileStats && file === getGlobalClaudeFile()) {
      try {
        const currentStats = fs.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          logEvent('tengu_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (e) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          throw e
        }
        // File doesn't exist yet, no stale check needed
      }
    }

    // Re-read the current config to get latest state. If the file is
    // momentarily corrupted (concurrent writes, kill-during-write), this
    // returns defaults -- we must not write those back over good config.
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalClaudeFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: re-read config is missing auth that cache has; refusing to write to avoid wiping ~/.claudin/config.json. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return false
    }

    // Apply the merge function to get the updated config
    const mergedConfig = mergeFn(currentConfig)

    // Skip write if no changes (same reference returned)
    if (mergedConfig === currentConfig) {
      return false
    }

    // Filter out any values that match the defaults
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // Create timestamped backup of existing config before writing
    // We keep multiple backups to prevent data loss if a reset/corrupted config
    // overwrites a good backup. Backups are stored in ~/.claude/backups/ to
    // keep the home directory clean.
    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()

      // Ensure backup directory exists
      try {
        fs.mkdirSync(backupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      // Check existing backups first -- skip creating a new one if a recent
      // backup already exists. During startup, many saveGlobalConfig calls fire
      // within milliseconds of each other; without this check, each call
      // creates a new backup file that accumulates on disk.
      const MIN_BACKUP_INTERVAL_MS = 60_000
      const existingBackups = fs
        .readdirStringSync(backupDir)
        .filter(f => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // Most recent first (timestamps sort lexicographically)

      const mostRecentBackup = existingBackups[0]
      const mostRecentTimestamp = mostRecentBackup
        ? Number(mostRecentBackup.split('.backup.').pop())
        : 0
      const shouldCreateBackup =
        Number.isNaN(mostRecentTimestamp) ||
        Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

      // Never back up a corrupt current file (it would pollute the backup set),
      // and never prune healthy backups when we didn't add a fresh one — a
      // single bad write must not erode the good backup history.
      const currentFileParses = configFileParses(file)
      const didCreateBackup = shouldCreateBackup && currentFileParses

      if (didCreateBackup) {
        const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
        fs.copyFileSync(file, backupPath)
      }

      if (currentFileParses) {
        // Clean up old backups, keeping only the 5 most recent
        const MAX_BACKUPS = 5
        // Re-read if we just created one; otherwise reuse the list
        const backupsForCleanup = didCreateBackup
          ? fs
              .readdirStringSync(backupDir)
              .filter(f => f.startsWith(`${fileBase}.backup.`))
              .sort()
              .reverse()
          : existingBackups

        for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
          try {
            fs.unlinkSync(join(backupDir, oldBackup))
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`Failed to backup config: ${e}`, {
          level: 'error',
        })
      }
      // No file to backup or backup failed, continue with write
    }

    // Write config file with secure permissions - mode only applies to new files
    writeFileSyncAndFlush(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    if (file === getGlobalClaudeFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// Flag to track if config reading is allowed
let configReadingAllowed = false

export function isConfigReadingAllowed(): boolean {
  return configReadingAllowed
}

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // Ensure this is idempotent
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // Any reads to configuration before this flag is set show an console warning
  // to prevent us from adding config reading during module initialization
  configReadingAllowed = true
  // We only check the global config because currently all the configs share a file
  getConfig(
    getGlobalClaudeFile(),
    createDefaultGlobalConfig,
    true /* throw on invalid */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/**
 * Returns the directory where config backup files are stored.
 * Uses ~/.claude/backups/ to keep the home directory clean.
 */
function getConfigBackupDir(): string {
  return join(getClaudinConfigHomeDir(), 'backups')
}

/**
 * Find the most recent backup file for a given config file.
 * Checks ~/.claude/backups/ first, then falls back to the legacy location
 * (next to the config file) for backwards compatibility.
 * Returns the full path to the most recent backup, or null if none exist.
 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // Check the new backup directory first
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // Timestamps sort lexicographically
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // Backup dir doesn't exist yet
  }

  // Fall back to legacy location (next to the config file)
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // Timestamps sort lexicographically
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // Check for legacy backup file (no timestamp)
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // Legacy backup doesn't exist
    }
  } catch {
    // Ignore errors reading directory
  }

  return null
}

/**
 * Returns true if the on-disk config file exists and parses as JSON. Used to
 * avoid backing up (or pruning against) a corrupt config: a single bad write
 * must not be copied into the backup set nor cause healthy backups to be pruned.
 */
function configFileParses(file: string): boolean {
  const fs = getFsImplementation()
  try {
    jsonParse(stripBOM(fs.readFileSync(file, { encoding: 'utf-8' })))
    return true
  } catch {
    return false
  }
}

/**
 * Walk config backups (newest first: new backup dir, then the legacy location
 * next to the config file) and return the first that parses cleanly, merged
 * with defaults. Returns null if none parse. Lets getConfig auto-recover from a
 * bad write instead of silently resetting the user to defaults.
 */
function recoverConfigFromBackup<A>(
  file: string,
  createDefault: () => A,
): { config: A; backupPath: string } | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const seen = new Set<string>()
  for (const dir of [getConfigBackupDir(), dirname(file)]) {
    let entries: string[]
    try {
      entries = fs
        .readdirStringSync(dir)
        .filter(f => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // newest first (timestamps sort lexicographically)
    } catch {
      continue // backup dir doesn't exist
    }
    for (const entry of entries) {
      const backupPath = join(dir, entry)
      if (seen.has(backupPath)) continue
      seen.add(backupPath)
      try {
        const parsed = jsonParse(
          stripBOM(fs.readFileSync(backupPath, { encoding: 'utf-8' })),
        )
        return { config: { ...createDefault(), ...parsed }, backupPath }
      } catch {
        // Corrupt/unreadable backup — try the next oldest
      }
    }
  }
  return null
}

export function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // Log a warning if config is accessed before it's allowed
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // Strip BOM before parsing - PowerShell 5.x adds BOM to UTF-8 files
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // Throw a ConfigParseError with the file path and default config
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // Handle file not found - check for backup and return default
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nClaude configuration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    // Re-throw ConfigParseError if throwOnInvalid is true
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // Log config parse errors so users know what happened
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      // Guard: logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // causes infinite recursion when the config file is corrupted, because
      // the sampling check reads a GrowthBook feature from global config.
      // Only log analytics on the outermost call.
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // Log the error for monitoring
          logError(error)

          // Log analytics event for config corruption
          let hasBackup = false
          try {
            fs.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // No backup
          }
          logEvent('tengu_config_parse_error', {
            has_backup: hasBackup,
          })
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nClaude configuration file at ${file} is corrupted: ${error.message}\n`,
      )

      // Try to backup the corrupted config file (only if not already backed up)
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // Ensure backup directory exists
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // Check if current corrupted content matches any existing backup
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // Ignore read errors on backups
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(
            `Corrupted config backed up to: ${corruptedBackupPath}`,
            {
              level: 'error',
            },
          )
        } catch {
          // Ignore backup errors
        }
      }

      // Auto-recover from the most recent parseable backup before falling back
      // to defaults, so a single bad write doesn't silently wipe the user's
      // settings. The corrupt file has already been preserved above.
      const recovered = recoverConfigFromBackup(file, createDefault)
      if (recovered) {
        if (corruptedBackupPath) {
          process.stderr.write(
            `The corrupted file has been backed up to: ${corruptedBackupPath}\n`,
          )
        }
        // Heal the on-disk file by restoring the good backup over it. Without
        // this, every subsequent getConfig() re-parses the corrupt file and
        // re-prints this message until the next successful save.
        let healed = false
        try {
          fs.copyFileSync(recovered.backupPath, file)
          healed = true
        } catch {
          // Best-effort: fall back to in-memory recovery only
        }
        process.stderr.write(
          healed
            ? `Recovered configuration from backup: ${recovered.backupPath}\n\n`
            : `Recovered configuration from backup (in memory): ${recovered.backupPath}\n\n`,
        )
        return recovered.config
      }

      // Notify user about corrupted config and available backup
      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(
          `The corrupted file has been backed up to: ${corruptedBackupPath}\n`,
        )
      } else if (alreadyBackedUp) {
        process.stderr.write(`The corrupted file has already been backed up.\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}
