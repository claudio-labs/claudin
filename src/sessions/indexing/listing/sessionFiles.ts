/**
 * The session files of one project directory, from directory entries and
 * file stats alone. Nothing here opens a transcript.
 */
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { validateUuid } from 'src/shared/data/uuid.js'
import type { LogOption } from 'src/shared/types/logs.js'

export type SessionFileStat = { path: string; mtime: number; ctime: number; size: number }

const TRANSCRIPT_SUFFIX = '.jsonl'

/** The session id a directory entry names, when it is `<uuid>.jsonl`. */
function sessionIdOfName(name: string): string | undefined {
  if (!name.endsWith(TRANSCRIPT_SUFFIX)) return undefined
  const id = name.slice(0, -TRANSCRIPT_SUFFIX.length)
  return validateUuid(id) ? id : undefined
}

async function statOf(path: string): Promise<SessionFileStat | undefined> {
  try {
    const st = await stat(path)
    // `ctime` carries the birth time: it orders sessions created in the same tick.
    return { path, mtime: st.mtime.getTime(), ctime: st.birthtime.getTime(), size: st.size }
  } catch (error) {
    logForDebugging(`Session file ${path} vanished or cannot be stat'ed: ${String(error)}`)
    return undefined
  }
}

async function regularFileNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    // Directory entries do not follow symlinks, so a link named like a session is no file here.
    return entries.filter(entry => entry.isFile()).map(entry => entry.name)
  } catch (error) {
    logForDebugging(`No session directory at ${dir}: ${String(error)}`)
    return []
  }
}

/** Session id (as the file names it) → path and stats, for the files directly in `projectDir`. */
export async function listSessionFiles(projectDir: string): Promise<Map<string, SessionFileStat>> {
  const named = (await regularFileNames(projectDir)).flatMap(name => {
    const id = sessionIdOfName(name)
    return id === undefined ? [] : [{ id, path: join(projectDir, name) }]
  })
  const stats = await Promise.all(named.map(({ path }) => statOf(path)))
  const files = new Map<string, SessionFileStat>()
  named.forEach(({ id }, index) => {
    const found = stats[index]
    if (found) files.set(id, found)
  })
  return files
}

/** The record a session file lists as before anything is read from it. */
export function statOnlyRecord(sessionId: string, file: SessionFileStat, projectPath: string | undefined): LogOption {
  const modified = new Date(file.mtime)
  return {
    date: modified.toISOString(),
    messages: [],
    isLite: true,
    fullPath: file.path,
    value: 0,
    created: new Date(file.ctime),
    modified,
    firstPrompt: '',
    messageCount: 0,
    fileSize: file.size,
    isSidechain: false,
    sessionId,
    projectPath,
  }
}

/** Newest modification first. */
export function newestFilesFirst(files: Iterable<SessionFileStat>): SessionFileStat[] {
  return [...files].sort((a, b) => b.mtime - a.mtime)
}
