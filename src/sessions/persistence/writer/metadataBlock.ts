/**
 * The cached session metadata and the block of lines it re-appends at the end
 * of the transcript. The order of that block lives here and nowhere else.
 */
import type { UUID } from 'crypto'
import type {
  AgentColorMessage,
  AgentNameMessage,
  AgentSettingMessage,
  CustomTitleMessage,
  LastPromptMessage,
  ModeEntry,
  PersistedWorktreeSession,
  PRLinkMessage,
  TagMessage,
  WorktreeStateEntry,
} from 'src/shared/types/logs.js'

type SessionMode = 'coordinator' | 'normal'

export type MetadataSnapshot = {
  lastPrompt?: string
  title?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: SessionMode
  /** `undefined` when never set; `null` once a worktree was left. */
  worktree?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

export type MetadataLine =
  | LastPromptMessage
  | CustomTitleMessage
  | TagMessage
  | AgentNameMessage
  | AgentColorMessage
  | AgentSettingMessage
  | ModeEntry
  | WorktreeStateEntry
  | PRLinkMessage

export const titleLine = (sessionId: UUID, customTitle: string): CustomTitleMessage => ({
  type: 'custom-title',
  customTitle,
  sessionId,
})

export const tagLine = (sessionId: UUID, tag: string): TagMessage => ({ type: 'tag', tag, sessionId })

export const agentNameLine = (sessionId: UUID, agentName: string): AgentNameMessage => ({
  type: 'agent-name',
  agentName,
  sessionId,
})

export const agentColorLine = (sessionId: UUID, agentColor: string): AgentColorMessage => ({
  type: 'agent-color',
  agentColor,
  sessionId,
})

export const worktreeLine = (sessionId: UUID, worktreeSession: PersistedWorktreeSession | null): WorktreeStateEntry => ({
  type: 'worktree-state',
  worktreeSession,
  sessionId,
})

export function prLinkLine(
  sessionId: UUID,
  link: { prNumber: number; prUrl: string; prRepository: string },
  now: Date,
): PRLinkMessage {
  return { type: 'pr-link', sessionId, ...link, timestamp: now.toISOString() }
}

/** The block, in the order the session list and resume expect it. */
export function metadataBlock(cache: MetadataSnapshot, sessionId: UUID, now: Date): MetadataLine[] {
  const lines: MetadataLine[] = []
  if (cache.lastPrompt) lines.push({ type: 'last-prompt', lastPrompt: cache.lastPrompt, sessionId })
  if (cache.title) lines.push(titleLine(sessionId, cache.title))
  if (cache.tag) lines.push(tagLine(sessionId, cache.tag))
  if (cache.agentName) lines.push(agentNameLine(sessionId, cache.agentName))
  if (cache.agentColor) lines.push(agentColorLine(sessionId, cache.agentColor))
  if (cache.agentSetting) lines.push({ type: 'agent-setting', agentSetting: cache.agentSetting, sessionId })
  if (cache.mode) lines.push({ type: 'mode', mode: cache.mode, sessionId })
  if (cache.worktree !== undefined) lines.push(worktreeLine(sessionId, cache.worktree))
  const { prNumber, prUrl, prRepository } = cache
  if (prNumber !== undefined && prUrl && prRepository) {
    lines.push(prLinkLine(sessionId, { prNumber, prUrl, prRepository }, now))
  }
  return lines
}

/** Only the fields the transcript keeps; run-time extras are left behind. */
export function persistedWorktree(session: PersistedWorktreeSession): PersistedWorktreeSession {
  return {
    originalCwd: session.originalCwd,
    worktreePath: session.worktreePath,
    worktreeName: session.worktreeName,
    worktreeBranch: session.worktreeBranch,
    originalBranch: session.originalBranch,
    originalHeadCommit: session.originalHeadCommit,
    sessionId: session.sessionId,
    tmuxSessionName: session.tmuxSessionName,
    hookBased: session.hookBased,
    attached: session.attached,
  }
}

const TITLE_OPENER = '{"type":"custom-title"'
const TAG_OPENER = '{"type":"tag"'

/** What another process left in the tail: `undefined` when it wrote nothing. */
export type ExternalWrites = { title?: string; tag?: string }

function stringMember(line: string, key: string): string | undefined {
  try {
    const value: unknown = (JSON.parse(line) as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The last title and tag lines in `tail`. A line counts only when it opens
 * with the compact `type` member, which is how every writer emits them.
 */
export function readExternalWrites(tail: string): ExternalWrites {
  const found: ExternalWrites = {}
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (found.title === undefined && line.startsWith(TITLE_OPENER)) found.title = stringMember(line, 'customTitle')
    else if (found.tag === undefined && line.startsWith(TAG_OPENER)) found.tag = stringMember(line, 'tag')
    if (found.title !== undefined && found.tag !== undefined) break
  }
  return found
}
