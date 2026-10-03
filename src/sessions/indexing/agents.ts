/**
 * Agent metadata sidecars — extracted Wave 4 of the 11c split.
 *
 * Local agents: `<agentId>.meta.json` sibling to the agent's transcript JSONL.
 *
 * No state; pure read/write helpers.
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  getOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import type { AgentId } from 'src/shared/types/ids.js'
import { isFsInaccessible } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import {
  getAgentTranscriptPath,
  getProjectDir,
} from 'src/sessions/pure/paths.js'

function getAgentMetadataPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(/\.jsonl$/, '.meta.json')
}

export type AgentMetadata = {
  agentType: string
  /** Worktree path if the agent was spawned with isolation: "worktree" */
  worktreePath?: string
  /** Original task description from the AgentTool input. Persisted so a
   * resumed agent's notification can show the original description instead
   * of a placeholder. Optional — older metadata files lack this field. */
  description?: string
  /** The spawn passed `readOnly: true`. Resume re-applies it — the definition
   * is looked up again by agentType, which alone would hand a research agent
   * its write tools back. */
  readOnly?: boolean
}

/**
 * Persist the agentType used to launch a subagent. Read by resume to
 * route correctly when subagent_type is omitted — without this, resuming
 * a fork silently degrades to code (4KB system prompt, no
 * inherited history). Sidecar file avoids JSONL schema changes.
 *
 * Also stores the worktreePath when the agent was spawned with worktree
 * isolation, enabling resume to restore the correct cwd.
 */
export async function writeAgentMetadata(
  agentId: AgentId,
  metadata: AgentMetadata,
): Promise<void> {
  const path = getAgentMetadataPath(agentId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readAgentMetadata(
  agentId: AgentId,
): Promise<AgentMetadata | null> {
  const path = getAgentMetadataPath(agentId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as AgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

export function sessionIdExists(sessionId: string): boolean {
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}
