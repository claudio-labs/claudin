import { isAbsolute, join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from 'src/platform/bootstrap/state.js'
import { getProjectsDir, sanitizePath } from 'src/sessions/sessionStoragePortable.js'
import type { AgentId } from 'src/shared/types/ids.js'

export { getProjectsDir }

/** The cap for callers that read a whole transcript into memory. */
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

// Keyed on the projects directory as well as the cwd, so a config home that
// moves is honoured without anyone having to clear the memo.
const projectDirs = new Map<string, string>()

function memoizedProjectDir(cwd: string): string {
  const projectsDir = getProjectsDir()
  const key = `${projectsDir}\0${cwd}`
  const known = projectDirs.get(key)
  if (known !== undefined) return known
  const dir = join(projectsDir, sanitizePath(cwd))
  projectDirs.set(key, dir)
  return dir
}

/** `<projects>/<sanitized cwd>`, memoized; `cache.clear()` empties the memo. */
export const getProjectDir = Object.assign(memoizedProjectDir, {
  cache: { clear: (): void => projectDirs.clear() },
})

function currentSessionDir(): string {
  return getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
}

export function getTranscriptPath(): string {
  return join(currentSessionDir(), `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  if (sessionId === getSessionId()) return getTranscriptPath()
  // Only the current session's directory is tracked; any other session is
  // looked up where the original cwd keeps its sessions.
  return join(getProjectDir(getOriginalCwd()), `${sessionId}.jsonl`)
}

const agentSubdirs = new Map<string, string>()

/** Groups one agent's transcript under `subagents/<subdir>/`, e.g. a workflow run. */
export function setAgentTranscriptSubdir(agentId: string, subdir: string): void {
  agentSubdirs.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  agentSubdirs.delete(agentId)
}

const PATH_SEPARATOR = /[\\/]/

// A grouping directory may only nest below `subagents/`. One that is absolute
// or climbs with `..` is ignored rather than trusted.
function nestedSubdir(subdir: string | undefined): string | undefined {
  if (!subdir || isAbsolute(subdir)) return undefined
  return subdir.split(PATH_SEPARATOR).includes('..') ? undefined : subdir
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  const subagentsDir = join(currentSessionDir(), getSessionId(), 'subagents')
  const fileName = `agent-${agentId}.jsonl`
  const subdir = nestedSubdir(agentSubdirs.get(agentId))
  return subdir ? join(subagentsDir, subdir, fileName) : join(subagentsDir, fileName)
}
