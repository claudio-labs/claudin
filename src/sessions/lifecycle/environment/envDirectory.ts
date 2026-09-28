/**
 * `<config dir>/session-env/<session id>`, where the current session's hooks
 * leave their `export` lines. It is resolved at every call, so it follows the
 * session, and created when a hook needs it.
 */
import { mkdir, readdir, writeFile } from 'fs/promises'
import { join } from 'path'

import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  type ExportingHookEvent,
  hookEnvFileName,
  isDirectoryScopedHookEnvFile,
} from 'src/sessions/lifecycle/environment/hookEnvFiles.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'

/**
 * The files may export secrets such as tokens, and every command sources
 * them: no other local user may read one or plant one.
 */
const OWNER_ONLY = 0o700

export function sessionEnvDirectory(): string {
  return join(getClaudinConfigHomeDir(), 'session-env', getSessionId())
}

export async function getHookEnvFilePath(
  hookEvent: ExportingHookEvent,
  hookIndex: number,
): Promise<string> {
  const dir = sessionEnvDirectory()
  await mkdir(dir, { recursive: true, mode: OWNER_ONLY })
  return join(dir, hookEnvFileName(hookEvent, hookIndex))
}

/** The names in `dir`; none when it does not exist yet or cannot be listed. */
export async function listDirectory(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Cannot list the session environment directory ${dir}: ${errorMessage(error)}`)
    }
    return []
  }
}

/**
 * Empty the CwdChanged and FileChanged hook files before those hooks run for
 * a new directory. The cached script is not invalidated here: the directory
 * change that calls this invalidates it.
 */
export async function clearCwdEnvFiles(): Promise<void> {
  const dir = sessionEnvDirectory()
  const stale = (await listDirectory(dir)).filter(isDirectoryScopedHookEnvFile)
  await Promise.all(stale.map(name => emptyFile(join(dir, name))))
}

async function emptyFile(path: string): Promise<void> {
  try {
    await writeFile(path, '')
  } catch (error) {
    logForDebugging(`Cannot empty the session environment file ${path}: ${errorMessage(error)}`)
  }
}
