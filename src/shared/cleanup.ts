import * as fs from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { logEvent } from 'src/platform/analytics/index.js'
import { CACHE_PATHS } from 'src/shared/fs/cachePaths.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { type FsOperations, getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { cleanupOldImageCaches } from 'src/terminal/image/imageStore.js'
import * as lockfile from 'src/shared/fs/lockfile.js'
import { logError } from 'src/shared/log.js'
import { cleanupOldVersions } from 'src/platform/install/index.js'
import { cleanupOldPastes } from 'src/terminal/input/pasteStore.js'
import { getPlansDirectory } from 'src/utils/plans.js'
import { getProjectsDir } from 'src/services/session/sessionStorage.js'
import { getSettingsWithAllErrors } from 'src/platform/settings/allErrors.js'
import { getTaskListId, sanitizePathComponent } from 'src/tasks/tasks.js'
import {
  getInitialSettings,
  rawSettingsContainsKey,
} from 'src/platform/settings/settings.js'
import { TOOL_RESULTS_SUBDIR } from 'src/services/tools/toolResultStorage.js'
import { cleanupStaleAgentWorktrees } from 'src/services/git/worktree.js'

const DEFAULT_CLEANUP_PERIOD_DAYS = 30

function getCutoffDate(): Date {
  const settings = getInitialSettings() || {}
  const cleanupPeriodDays =
    settings.cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS
  const cleanupPeriodMs = cleanupPeriodDays * 24 * 60 * 60 * 1000
  return new Date(Date.now() - cleanupPeriodMs)
}

export type CleanupResult = {
  messages: number
  errors: number
}

export function addCleanupResults(
  a: CleanupResult,
  b: CleanupResult,
): CleanupResult {
  return {
    messages: a.messages + b.messages,
    errors: a.errors + b.errors,
  }
}

export function convertFileNameToDate(filename: string): Date {
  const isoStr = filename
    .split('.')[0]!
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
  return new Date(isoStr)
}

async function cleanupOldFilesInDirectory(
  dirPath: string,
  cutoffDate: Date,
  isMessagePath: boolean,
): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }

  try {
    const files = await getFsImplementation().readdir(dirPath)

    for (const file of files) {
      try {
        // Convert filename format where all ':.' were replaced with '-'
        const timestamp = convertFileNameToDate(file.name)
        if (timestamp < cutoffDate) {
          await getFsImplementation().unlink(join(dirPath, file.name))
          // Increment the appropriate counter
          if (isMessagePath) {
            result.messages++
          } else {
            result.errors++
          }
        }
      } catch (error) {
        // Log but continue processing other files
        logError(error as Error)
      }
    }
  } catch (error: unknown) {
    // Ignore if directory doesn't exist
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      logError(error)
    }
  }

  return result
}

export async function cleanupOldMessageFiles(): Promise<CleanupResult> {
  const fsImpl = getFsImplementation()
  const cutoffDate = getCutoffDate()
  const errorPath = CACHE_PATHS.errors()
  const baseCachePath = CACHE_PATHS.baseLogs()

  // Clean up message and error logs
  let result = await cleanupOldFilesInDirectory(errorPath, cutoffDate, false)

  // Clean up MCP logs
  try {
    let dirents
    try {
      dirents = await fsImpl.readdir(baseCachePath)
    } catch {
      return result
    }

    const mcpLogDirs = dirents
      .filter(
        dirent => dirent.isDirectory() && dirent.name.startsWith('mcp-logs-'),
      )
      .map(dirent => join(baseCachePath, dirent.name))

    for (const mcpLogDir of mcpLogDirs) {
      // Clean up files in MCP log directory
      result = addCleanupResults(
        result,
        await cleanupOldFilesInDirectory(mcpLogDir, cutoffDate, true),
      )
      await tryRmdir(mcpLogDir, fsImpl)
    }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      logError(error)
    }
  }

  return result
}

async function unlinkIfOld(
  filePath: string,
  cutoffDate: Date,
  fsImpl: FsOperations,
): Promise<boolean> {
  const stats = await fsImpl.stat(filePath)
  if (stats.mtime < cutoffDate) {
    await fsImpl.unlink(filePath)
    return true
  }
  return false
}

async function tryRmdir(dirPath: string, fsImpl: FsOperations): Promise<void> {
  try {
    await fsImpl.rmdir(dirPath)
  } catch {
    // not empty / doesn't exist
  }
}

export async function cleanupOldSessionFiles(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const projectsDir = getProjectsDir()
  const fsImpl = getFsImplementation()

  let projectDirents
  try {
    projectDirents = await fsImpl.readdir(projectsDir)
  } catch {
    return result
  }

  for (const projectDirent of projectDirents) {
    if (!projectDirent.isDirectory()) continue
    const projectDir = join(projectsDir, projectDirent.name)

    // Single readdir per project directory — partition into files and session dirs
    let entries
    try {
      entries = await fsImpl.readdir(projectDir)
    } catch {
      result.errors++
      continue
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.cast')) {
          continue
        }
        try {
          if (
            await unlinkIfOld(join(projectDir, entry.name), cutoffDate, fsImpl)
          ) {
            result.messages++
          }
        } catch {
          result.errors++
        }
      } else if (entry.isDirectory()) {
        // Session directory — clean up tool-results/<toolDir>/* beneath it
        const sessionDir = join(projectDir, entry.name)
        const toolResultsDir = join(sessionDir, TOOL_RESULTS_SUBDIR)
        let toolDirs
        try {
          toolDirs = await fsImpl.readdir(toolResultsDir)
        } catch {
          // No tool-results dir — still try to remove an empty session dir
          await tryRmdir(sessionDir, fsImpl)
          continue
        }
        for (const toolEntry of toolDirs) {
          if (toolEntry.isFile()) {
            try {
              if (
                await unlinkIfOld(
                  join(toolResultsDir, toolEntry.name),
                  cutoffDate,
                  fsImpl,
                )
              ) {
                result.messages++
              }
            } catch {
              result.errors++
            }
          } else if (toolEntry.isDirectory()) {
            const toolDirPath = join(toolResultsDir, toolEntry.name)
            let toolFiles
            try {
              toolFiles = await fsImpl.readdir(toolDirPath)
            } catch {
              continue
            }
            for (const tf of toolFiles) {
              if (!tf.isFile()) continue
              try {
                if (
                  await unlinkIfOld(
                    join(toolDirPath, tf.name),
                    cutoffDate,
                    fsImpl,
                  )
                ) {
                  result.messages++
                }
              } catch {
                result.errors++
              }
            }
            await tryRmdir(toolDirPath, fsImpl)
          }
        }
        await tryRmdir(toolResultsDir, fsImpl)
        await tryRmdir(sessionDir, fsImpl)
      }
    }

    await tryRmdir(projectDir, fsImpl)
  }

  return result
}

/**
 * Generic helper for cleaning up old files in a single directory
 * @param dirPath Path to the directory to clean
 * @param extension File extension to filter (e.g., '.md', '.jsonl')
 * @param removeEmptyDir Whether to remove the directory if empty after cleanup
 */
async function cleanupSingleDirectory(
  dirPath: string,
  extension: string,
  removeEmptyDir: boolean = true,
): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  let dirents
  try {
    dirents = await fsImpl.readdir(dirPath)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(extension)) continue
    try {
      if (await unlinkIfOld(join(dirPath, dirent.name), cutoffDate, fsImpl)) {
        result.messages++
      }
    } catch {
      result.errors++
    }
  }

  if (removeEmptyDir) {
    await tryRmdir(dirPath, fsImpl)
  }

  return result
}

export async function cleanupOldPlanFiles(): Promise<CleanupResult> {
  const plansDir = getPlansDirectory()
  const result = await cleanupSingleDirectory(plansDir, '.md')

  // The plans directory used to default to ~/.claudin/plans/ (project-local
  // .claudin/plans/ is the default now); sweep the legacy location too so
  // orphaned plan files from before this change still age out.
  const legacyPlansDir = join(getClaudinConfigHomeDir(), 'plans')
  if (legacyPlansDir !== plansDir) {
    const legacyResult = await cleanupSingleDirectory(legacyPlansDir, '.md')
    return addCleanupResults(result, legacyResult)
  }

  return result
}

export async function cleanupOldFileHistoryBackups(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  try {
    const configDir = getClaudinConfigHomeDir()
    const fileHistoryStorageDir = join(configDir, 'file-history')

    let dirents
    try {
      dirents = await fsImpl.readdir(fileHistoryStorageDir)
    } catch {
      return result
    }

    const fileHistorySessionsDirs = dirents
      .filter(dirent => dirent.isDirectory())
      .map(dirent => join(fileHistoryStorageDir, dirent.name))

    await Promise.all(
      fileHistorySessionsDirs.map(async fileHistorySessionDir => {
        try {
          const stats = await fsImpl.stat(fileHistorySessionDir)
          if (stats.mtime < cutoffDate) {
            await fsImpl.rm(fileHistorySessionDir, {
              recursive: true,
              force: true,
            })
            result.messages++
          }
        } catch {
          result.errors++
        }
      }),
    )

    await tryRmdir(fileHistoryStorageDir, fsImpl)
  } catch (error) {
    logError(error as Error)
  }

  return result
}

export async function cleanupOldSessionEnvDirs(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  try {
    const configDir = getClaudinConfigHomeDir()
    const sessionEnvBaseDir = join(configDir, 'session-env')

    let dirents
    try {
      dirents = await fsImpl.readdir(sessionEnvBaseDir)
    } catch {
      return result
    }

    const sessionEnvDirs = dirents
      .filter(dirent => dirent.isDirectory())
      .map(dirent => join(sessionEnvBaseDir, dirent.name))

    for (const sessionEnvDir of sessionEnvDirs) {
      try {
        const stats = await fsImpl.stat(sessionEnvDir)
        if (stats.mtime < cutoffDate) {
          await fsImpl.rm(sessionEnvDir, { recursive: true, force: true })
          result.messages++
        }
      } catch {
        result.errors++
      }
    }

    await tryRmdir(sessionEnvBaseDir, fsImpl)
  } catch (error) {
    logError(error as Error)
  }

  return result
}

/**
 * Sweeps stale TodoV2 task lists from ~/.claudin/tasks/. One directory is
 * created per task list — normally per session — and nothing ever removed them:
 * a session that ended with unfinished tasks left its JSON behind forever, and
 * finished batches now stay on disk too (they're archived rather than deleted,
 * see `archiveCompletedTasks`).
 *
 * The live list is skipped by name regardless of mtime. Other sessions' lists
 * are protected by age alone, which is why the age is the newest mtime *inside*
 * the directory rather than the directory's own — see `newestTaskListMtime`.
 */
export async function cleanupOldTaskListDirs(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  try {
    const tasksBaseDir = join(getClaudinConfigHomeDir(), 'tasks')
    const activeDirName = sanitizePathComponent(getTaskListId())

    let dirents
    try {
      dirents = await fsImpl.readdir(tasksBaseDir)
    } catch {
      return result
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name === activeDirName) continue
      const taskListDir = join(tasksBaseDir, dirent.name)
      try {
        const mtime = await newestTaskListMtime(taskListDir, fsImpl)
        if (mtime < cutoffDate) {
          await fsImpl.rm(taskListDir, { recursive: true, force: true })
          result.messages++
        }
      } catch {
        result.errors++
      }
    }

    await tryRmdir(tasksBaseDir, fsImpl)
  } catch (error) {
    logError(error as Error)
  }

  return result
}

/**
 * Newest mtime among a task-list directory and the task files in it.
 *
 * The directory's own mtime only moves when an entry is added or removed, and
 * `updateTask` rewrites each JSON in place — so a second Claudin session that
 * has been ticking statuses all week still looks untouched since the day its
 * list was created. Reading the files' mtimes is what keeps this sweep from
 * deleting a list another live session is holding.
 */
async function newestTaskListMtime(
  dir: string,
  fsImpl: FsOperations,
): Promise<Date> {
  let newest = (await fsImpl.stat(dir)).mtime
  const entries = await fsImpl.readdir(dir).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const { mtime } = await fsImpl.stat(join(dir, entry.name))
      if (mtime > newest) newest = mtime
    } catch {
      // Unreadable entry — the directory mtime already bounds us.
    }
  }
  return newest
}

/**
 * Cleans up old debug log files from ~/.claude/debug/
 * Preserves the 'latest' symlink which points to the current session's log.
 * Debug logs can grow very large (especially with the infinite logging loop bug)
 * and accumulate indefinitely without this cleanup.
 */
export async function cleanupOldDebugLogs(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()
  const debugDir = join(getClaudinConfigHomeDir(), 'debug')

  let dirents
  try {
    dirents = await fsImpl.readdir(debugDir)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    // Preserve the 'latest' symlink
    if (
      !dirent.isFile() ||
      !dirent.name.endsWith('.txt') ||
      dirent.name === 'latest'
    ) {
      continue
    }
    try {
      if (await unlinkIfOld(join(debugDir, dirent.name), cutoffDate, fsImpl)) {
        result.messages++
      }
    } catch {
      result.errors++
    }
  }

  // Intentionally do NOT remove debugDir even if empty — needed for future logs
  return result
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000


export async function cleanupOldMessageFilesInBackground(): Promise<void> {
  // If settings have validation errors but the user explicitly set cleanupPeriodDays,
  // skip cleanup entirely rather than falling back to the default (30 days).
  // This prevents accidentally deleting files when the user intended a different retention period.
  const { errors } = getSettingsWithAllErrors()
  if (errors.length > 0 && rawSettingsContainsKey('cleanupPeriodDays')) {
    logForDebugging(
      'Skipping cleanup: settings have validation errors but cleanupPeriodDays was explicitly set. Fix settings errors to enable cleanup.',
    )
    return
  }

  await cleanupOldMessageFiles()
  await cleanupOldSessionFiles()
  await cleanupOldPlanFiles()
  await cleanupOldFileHistoryBackups()
  await cleanupOldSessionEnvDirs()
  await cleanupOldTaskListDirs()
  await cleanupOldDebugLogs()
  await cleanupOldImageCaches()
  await cleanupOldPastes(getCutoffDate())
  const removedWorktrees = await cleanupStaleAgentWorktrees(getCutoffDate())
  if (removedWorktrees > 0) {
    logEvent('tengu_worktree_cleanup', { removed: removedWorktrees })
  }
}
