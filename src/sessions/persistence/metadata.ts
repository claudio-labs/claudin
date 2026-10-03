/**
 * Session metadata persistence (title, tag, agent name/color, mode,
 * worktree state, PR link). All `saveX` functions append to disk AND
 * update the Project singleton's in-memory cache so the current session
 * sees the value immediately.
 *
 * Extracted in Wave 3 of the 11c sessionStorage split.
 */
import type { UUID } from 'crypto'
import { existsSync } from 'fs'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import type { SessionId } from 'src/shared/types/ids.js'
import type { PersistedWorktreeSession } from 'src/shared/types/logs.js'
import { updateSessionName } from 'src/sessions/concurrentSessions.js'
import { appendEntryToFile } from 'src/sessions/persistence/_helpers.js'
import { getProject } from 'src/sessions/persistence/project.js'
import { getTranscriptPathForSession } from 'src/sessions/pure/paths.js'
import { isPersistenceDisabledByUser } from 'src/sessions/persistence/writer/gate.js'
import {
  agentColorLine,
  agentNameLine,
  persistedWorktree,
  prLinkLine,
  tagLine,
  titleLine,
  worktreeLine,
  type MetadataLine,
} from 'src/sessions/persistence/writer/metadataBlock.js'
import { logError } from 'src/shared/log.js'

const isCurrentSession = (sessionId: string): boolean => sessionId === getSessionId()

/**
 * Appends one metadata line at once. With persistence off, the current
 * session keeps it in the cache only, and another session's file is written
 * only when it already exists, since the user named that session (finding 2).
 */
function writeMetadataLine(
  sessionId: UUID,
  line: MetadataLine | Record<string, unknown>,
  fullPath: string | undefined,
): void {
  const file = fullPath ?? getTranscriptPathForSession(sessionId)
  if (isPersistenceDisabledByUser() && (isCurrentSession(sessionId) || !existsSync(file))) return
  appendEntryToFile(file, line)
}

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  writeMetadataLine(sessionId, titleLine(sessionId, customTitle), fullPath)
  if (isCurrentSession(sessionId)) getProject().currentSessionTitle = customTitle
}

export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  writeMetadataLine(sessionId, { type: 'ai-title', aiTitle, sessionId }, undefined)
}

export function saveTaskSummary(sessionId: UUID, summary: string): void {
  const line = { type: 'task-summary', summary, sessionId, timestamp: new Date().toISOString() }
  writeMetadataLine(sessionId, line, undefined)
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string) {
  writeMetadataLine(sessionId, tagLine(sessionId, tag), fullPath)
  if (isCurrentSession(sessionId)) getProject().currentSessionTag = tag
}

export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  writeMetadataLine(sessionId, prLinkLine(sessionId, { prNumber, prUrl, prRepository }, new Date()), fullPath)
  if (!isCurrentSession(sessionId)) return
  const cache = getProject()
  cache.currentSessionPrNumber = prNumber
  cache.currentSessionPrUrl = prUrl
  cache.currentSessionPrRepository = prRepository
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  return isCurrentSession(sessionId) ? getProject().currentSessionTag : undefined
}

export function getCurrentSessionTitle(
  sessionId: SessionId,
): string | undefined {
  return isCurrentSession(sessionId) ? getProject().currentSessionTitle : undefined
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().currentSessionAgentColor
}

export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}): void {
  const cache = getProject()
  // A title already cached came from --name, which beats the resumed one.
  if (meta.customTitle && cache.currentSessionTitle === undefined) cache.currentSessionTitle = meta.customTitle
  if (meta.tag !== undefined) cache.currentSessionTag = meta.tag || undefined
  if (meta.agentName) cache.currentSessionAgentName = meta.agentName
  if (meta.agentColor) cache.currentSessionAgentColor = meta.agentColor
  if (meta.agentSetting) cache.currentSessionAgentSetting = meta.agentSetting
  if (meta.mode) cache.currentSessionMode = meta.mode
  if (meta.worktreeSession !== undefined) cache.currentSessionWorktree = meta.worktreeSession
  if (meta.prNumber !== undefined) cache.currentSessionPrNumber = meta.prNumber
  if (meta.prUrl) cache.currentSessionPrUrl = meta.prUrl
  if (meta.prRepository) cache.currentSessionPrRepository = meta.prRepository
}

export function clearSessionMetadata(): void {
  const cache = getProject()
  cache.currentSessionTitle = undefined
  cache.currentSessionTag = undefined
  cache.currentSessionAgentName = undefined
  cache.currentSessionAgentColor = undefined
  cache.currentSessionLastPrompt = undefined
  cache.currentSessionAgentSetting = undefined
  cache.currentSessionMode = undefined
  cache.currentSessionWorktree = undefined
  cache.currentSessionPrNumber = undefined
  cache.currentSessionPrUrl = undefined
  cache.currentSessionPrRepository = undefined
}

export function reAppendSessionMetadata(): void {
  getProject().reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  writeMetadataLine(sessionId, agentNameLine(sessionId, agentName), fullPath)
  if (!isCurrentSession(sessionId)) return
  getProject().currentSessionAgentName = agentName
  updateSessionName(agentName).catch(logError)
}

export async function saveAgentColor(
  sessionId: UUID,
  agentColor: string,
  fullPath?: string,
) {
  writeMetadataLine(sessionId, agentColorLine(sessionId, agentColor), fullPath)
  if (isCurrentSession(sessionId)) getProject().currentSessionAgentColor = agentColor
}

export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

export function saveMode(mode: 'coordinator' | 'normal'): void {
  getProject().currentSessionMode = mode
}

export function saveWorktreeState(
  worktreeSession: PersistedWorktreeSession | null,
): void {
  const kept = worktreeSession ? persistedWorktree(worktreeSession) : null
  const current = getProject()
  current.currentSessionWorktree = kept
  if (!current.sessionFile || isPersistenceDisabledByUser()) return
  appendEntryToFile(current.sessionFile, worktreeLine(getSessionId() as UUID, kept))
}
