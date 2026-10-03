/**
 * Local agent sidecars: `agent-<agentId>.meta.json` beside the agent's
 * transcript, remembering how the agent was spawned so a resume restores it.
 * Also the check of whether a session id already has a transcript.
 */

import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  getOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import type { AgentId } from 'src/shared/types/ids.js'
import { getErrnoCode, isFsInaccessible } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import {
  getAgentTranscriptPath,
  getProjectDir,
} from 'src/sessions/pure/paths.js'

const TRANSCRIPT_SUFFIX = /\.jsonl$/

function getAgentMetadataPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(TRANSCRIPT_SUFFIX, '.meta.json')
}

export type AgentMetadata = {
  agentType: string
  worktreePath?: string
  description?: string
  /** The spawn passed `readOnly: true`. Resume re-applies it — the definition
   * is looked up again by agentType, which alone would hand a research agent
   * its write tools back. */
  readOnly?: boolean
}

function isAgentMetadata(value: unknown): value is AgentMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    'agentType' in value &&
    typeof value.agentType === 'string'
  )
}

/** Writes beside the target and renames over it, so a reader never sees half a file. */
async function replaceFile(path: string, contents: string): Promise<void> {
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(staging, contents, 'utf8')
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
}

export async function writeAgentMetadata(
  agentId: AgentId,
  metadata: AgentMetadata,
): Promise<void> {
  const path = getAgentMetadataPath(agentId)
  await mkdir(dirname(path), { recursive: true })
  await replaceFile(path, JSON.stringify(metadata))
}

/**
 * The stored sidecar, or null when there is none to use: missing, unreachable,
 * a directory, or not an object with a string `agentType`. The metadata is
 * optional (older agents have none), so a bad sidecar must not fail a resume.
 */
export async function readAgentMetadata(
  agentId: AgentId,
): Promise<AgentMetadata | null> {
  let text: string
  try {
    text = await readFile(getAgentMetadataPath(agentId), 'utf8')
  } catch (error) {
    if (isFsInaccessible(error) || getErrnoCode(error) === 'EISDIR') return null
    throw error
  }
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch {
    return null
  }
  return isAgentMetadata(stored) ? stored : null
}

/** Whether the original cwd's project folder holds a transcript for this id. */
export function sessionIdExists(sessionId: string): boolean {
  const transcript = join(getProjectDir(getOriginalCwd()), `${sessionId}.jsonl`)
  return getFsImplementation().existsSync(transcript)
}
