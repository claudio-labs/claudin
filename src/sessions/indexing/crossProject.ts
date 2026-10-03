/**
 * The session listings behind /resume: the sessions of every worktree of the
 * current repository, or of every project. Each is a stat-only listing of the
 * matching project folders, deduplicated by session id, followed by a first
 * read of the newest sessions for their titles.
 */

import { readdir } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { isFsInaccessible } from 'src/shared/errors.js'
import { sanitizePath } from 'src/shared/fs/path.js'
import {
  deduplicateLogsBySessionId,
  enrichLogs,
  getSessionFilesLite,
  INITIAL_ENRICH_COUNT,
} from 'src/sessions/indexing/liteMetadata.js'
import {
  getProjectDir,
  getProjectsDir,
} from 'src/sessions/pure/paths.js'

export type SessionLogResult = {
  logs: LogOption[]
  allStatLogs: LogOption[]
  nextIndex: number
}

type ProjectFolder = { dir: string; projectPath?: string }

type WorktreeKey = { worktreePath: string; folderName: string }

/** The folders directly under the projects folder, or null when it cannot be read. */
async function projectFolderNames(): Promise<string[] | null> {
  try {
    const entries = await readdir(getProjectsDir(), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if (isFsInaccessible(error)) return null
    throw error
  }
}

// Windows paths are case-insensitive, and the drive letter is spelled either way.
function foldCase(): (name: string) => string {
  return process.platform === 'win32' ? name => name.toLowerCase() : name => name
}

/**
 * The worktree a project folder belongs to: the folder of the worktree itself,
 * or of a session started below it (`<sanitized worktree>-…`). With several
 * matches the longest worktree wins, whatever order they were given in.
 */
function owningWorktree(folderName: string, keys: readonly WorktreeKey[]): string | undefined {
  const match = keys
    .filter(key => folderName === key.folderName || folderName.startsWith(`${key.folderName}-`))
    .reduce<WorktreeKey | undefined>(
      (best, key) => (best === undefined || key.folderName.length > best.folderName.length ? key : best),
      undefined,
    )
  return match?.worktreePath
}

/** Every folder's sessions, each folder cut to its newest `limit`, then one entry per session. */
async function listFolders(folders: readonly ProjectFolder[], limit?: number): Promise<LogOption[]> {
  const perFolder = await Promise.all(
    folders.map(folder => getSessionFilesLite(folder.dir, limit, folder.projectPath)),
  )
  return deduplicateLogsBySessionId(perFolder.flat())
}

async function readFirstSessions(allStatLogs: LogOption[], count: number): Promise<SessionLogResult> {
  const { logs, nextIndex } = await enrichLogs(allStatLogs, 0, count)
  return { logs: logs.map((log, value) => ({ ...log, value })), allStatLogs, nextIndex }
}

/**
 * `options.skipIndex` is accepted for the callers' types only: the full-parse
 * listing it selected had no caller and was dropped.
 */
export async function loadAllProjectsMessageLogs(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<LogOption[]> {
  const count = options?.initialEnrichCount ?? INITIAL_ENRICH_COUNT
  const { logs } = await loadAllProjectsMessageLogsProgressive(limit, count)
  return logs
}

export async function loadAllProjectsMessageLogsProgressive(
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  const names = await projectFolderNames()
  if (names === null) return { logs: [], allStatLogs: [], nextIndex: 0 }
  const projectsDir = getProjectsDir()
  const allStatLogs = await listFolders(
    names.map(name => ({ dir: join(projectsDir, name) })),
    limit,
  )
  return readFirstSessions(allStatLogs, initialEnrichCount)
}

export async function loadSameRepoMessageLogs(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<LogOption[]> {
  const { logs } = await loadSameRepoMessageLogsProgressive(worktreePaths, limit, initialEnrichCount)
  return logs
}

export async function loadSameRepoMessageLogsProgressive(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths, limit)
  return readFirstSessions(allStatLogs, initialEnrichCount)
}

export async function getStatOnlyLogsForWorktrees(
  worktreePaths: string[],
  limit?: number,
): Promise<LogOption[]> {
  if (worktreePaths.length <= 1) {
    const cwd = getOriginalCwd()
    return listFolders([{ dir: getProjectDir(cwd), projectPath: cwd }], limit)
  }

  const names = await projectFolderNames()
  if (names === null) return []
  const fold = foldCase()
  const keys = worktreePaths.map(worktreePath => ({
    worktreePath,
    folderName: fold(sanitizePath(worktreePath)),
  }))
  const projectsDir = getProjectsDir()
  const folders = names.flatMap(name => {
    const projectPath = owningWorktree(fold(name), keys)
    return projectPath === undefined ? [] : [{ dir: join(projectsDir, name), projectPath }]
  })
  return listFolders(folders, limit)
}
