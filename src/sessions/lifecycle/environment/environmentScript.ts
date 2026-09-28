/**
 * The script the shell provider runs before every command: the file a parent
 * process names in CLAUDIN_ENV_FILE (a virtualenv or conda activation it wants
 * kept across commands), then the session's hook env files, in order.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'

import {
  listDirectory,
  sessionEnvDirectory,
} from 'src/sessions/lifecycle/environment/envDirectory.js'
import { orderHookEnvFiles } from 'src/sessions/lifecycle/environment/hookEnvFiles.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'
import { getPlatform } from 'src/shared/proc/platform.js'

/**
 * One script for the whole process, null included, until invalidated. It
 * survives /clear and /resume on purpose: a virtualenv that a startup hook
 * activated stays active in the new session, whose own directory holds
 * nothing from that hook.
 */
let cachedScript: Promise<string | null> | undefined

export function getSessionEnvironmentScript(): Promise<string | null> {
  if (getPlatform() === 'windows') return Promise.resolve(null)
  cachedScript ??= assembleScript(sessionEnvDirectory(), process.env.CLAUDIN_ENV_FILE)
  return cachedScript
}

export function invalidateSessionEnvCache(): void {
  cachedScript = undefined
}

/** The files that hold text, each trimmed, joined by newlines; null when none does. */
async function assembleScript(dir: string, parentFile: string | undefined): Promise<string | null> {
  const hookFiles = orderHookEnvFiles(await listDirectory(dir)).map(name => join(dir, name))
  const files = parentFile ? [parentFile, ...hookFiles] : hookFiles
  const parts = await Promise.all(files.map(readTrimmed))
  const script = parts.filter(part => part.length > 0).join('\n')
  return script.length > 0 ? script : null
}

async function readTrimmed(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Skipping the unreadable session environment file ${path}: ${errorMessage(error)}`)
    }
    return ''
  }
}
