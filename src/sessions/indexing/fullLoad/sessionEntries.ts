/**
 * What a loaded transcript says about one session: the metadata entries keyed
 * by its id, its context-collapse state, and the snapshots of a chain. A file
 * can hold entries of several sessions (a fork carries its source's first
 * messages), so every lookup names the session it is for.
 */
import type { UUID } from 'crypto'
import type { LogOption, TranscriptMessage } from 'src/shared/types/logs.js'
import {
  buildAttributionSnapshotChain,
  buildFileHistorySnapshotChain,
  type loadTranscriptFile,
} from 'src/sessions/resume/transcriptLoad.js'

export type LoadedTranscript = Awaited<ReturnType<typeof loadTranscriptFile>>

export type SessionLabels = Pick<
  LogOption,
  'customTitle' | 'tag' | 'agentName' | 'agentColor' | 'agentSetting' | 'mode' | 'prNumber' | 'prUrl' | 'prRepository'
>

type SessionMode = NonNullable<LogOption['mode']>
const SESSION_MODES: ReadonlySet<string> = new Set<SessionMode>(['coordinator', 'normal'])

function isSessionMode(value: string | undefined): value is SessionMode {
  return value !== undefined && SESSION_MODES.has(value)
}

/** The last entry of each label kind the session wrote, or undefined. */
export function sessionLabels(loaded: LoadedTranscript, sessionId: string): SessionLabels {
  const id = sessionId as UUID
  const mode = loaded.modes.get(id)
  return {
    customTitle: loaded.customTitles.get(id),
    tag: loaded.tags.get(id),
    agentName: loaded.agentNames.get(id),
    agentColor: loaded.agentColors.get(id),
    agentSetting: loaded.agentSettings.get(id),
    mode: isSessionMode(mode) ? mode : undefined,
    prNumber: loaded.prNumbers.get(id),
    prUrl: loaded.prUrls.get(id),
    prRepository: loaded.prRepositories.get(id),
  }
}

export type CollapseState = Pick<LogOption, 'contextCollapseCommits' | 'contextCollapseSnapshot'>

/** The session's collapse commits in file order, and the snapshot when it is the session's. */
export function collapseStateOf(loaded: LoadedTranscript, sessionId: string): CollapseState {
  const snapshot = loaded.contextCollapseSnapshot
  return {
    contextCollapseCommits: loaded.contextCollapseCommits.filter(commit => commit.sessionId === sessionId),
    contextCollapseSnapshot: snapshot?.sessionId === sessionId ? snapshot : undefined,
  }
}

export type Snapshots = Pick<LogOption, 'fileHistorySnapshots' | 'attributionSnapshots'>

export function snapshotsOf(loaded: LoadedTranscript, chain: TranscriptMessage[]): Snapshots {
  return {
    fileHistorySnapshots: buildFileHistorySnapshotChain(loaded.fileHistorySnapshots, chain),
    attributionSnapshots: buildAttributionSnapshotChain(loaded.attributionSnapshots, chain),
  }
}

/** The worktree state the session last wrote, `null` included; `fallback` when it wrote none. */
export function worktreeOf(
  loaded: LoadedTranscript,
  sessionId: string,
  fallback: LogOption['worktreeSession'],
): LogOption['worktreeSession'] {
  const id = sessionId as UUID
  return loaded.worktreeStates.has(id) ? loaded.worktreeStates.get(id) : fallback
}

/** The summary entry that names `leafUuid`. */
export function summaryOf(loaded: LoadedTranscript, leafUuid: UUID): string | undefined {
  return loaded.summaries.get(leafUuid)
}
