import { randomUUID, type UUID } from 'crypto'
import type { AttributionSnapshotMessage, FileAttributionState } from 'src/shared/types/logs.js'

/**
 * Model families by their public name, most specific first: an id takes the
 * name of the first family it contains, so `opus-4-10` reads as `opus-4-1`.
 */
const PUBLIC_MODEL_FAMILIES = [
  'fable-5-1',
  'fable-5',
  'opus-5-5',
  'opus-5',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'opus-4-5',
  'opus-4-1',
  'opus-4',
  'sonnet-5',
  'sonnet-4-6',
  'sonnet-4-5',
  'sonnet-4',
  'sonnet-3-7',
  'haiku-4-5',
  'haiku-3-5',
] as const

const GENERIC_MODEL_NAME = 'claude'
const DEFAULT_SURFACE = 'cli'

export function sanitizeModelName(shortName: string): string {
  const family = PUBLIC_MODEL_FAMILIES.find(candidate => shortName.includes(candidate))
  return family === undefined ? GENERIC_MODEL_NAME : `${GENERIC_MODEL_NAME}-${family}`
}

type SessionBaseline = { contentHash: string; mtime: number }

type Counters = {
  promptCount: number
  promptCountAtLastCommit: number
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  escapeCount: number
  escapeCountAtLastCommit: number
}

export type AttributionState = Counters & {
  fileStates: Map<string, FileAttributionState>
  sessionBaselines: Map<string, SessionBaseline>
  surface: string
  startingHeadSha: string | null
}

/**
 * The six counters in the order a transcript line stores them. Every writer
 * goes through here, so that order is decided in one place.
 */
function countersFrom(source: Partial<Counters>): Counters {
  return {
    promptCount: source.promptCount ?? 0,
    promptCountAtLastCommit: source.promptCountAtLastCommit ?? 0,
    permissionPromptCount: source.permissionPromptCount ?? 0,
    permissionPromptCountAtLastCommit: source.permissionPromptCountAtLastCommit ?? 0,
    escapeCount: source.escapeCount ?? 0,
    escapeCountAtLastCommit: source.escapeCountAtLastCommit ?? 0,
  }
}

export function getClientSurface(): string {
  return process.env.CLAUDE_CODE_ENTRYPOINT ?? DEFAULT_SURFACE
}

export function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(),
    sessionBaselines: new Map(),
    surface: getClientSurface(),
    startingHeadSha: null,
    ...countersFrom({}),
  }
}

/**
 * The transcript entry for a state. Resume recognises the stored line by its
 * `{"type":"attribution-snapshot"` opening, so `type` has to stay the first
 * key. The baselines and the starting HEAD are not stored.
 */
export function stateToSnapshotMessage(state: AttributionState, messageId: UUID): AttributionSnapshotMessage {
  return {
    type: 'attribution-snapshot',
    messageId,
    surface: state.surface,
    fileStates: Object.fromEntries(state.fileStates),
    ...countersFrom(state),
  }
}

/** The latest snapshot is the whole state: nothing is added up across them. */
export function restoreAttributionStateFromSnapshots(snapshots: AttributionSnapshotMessage[]): AttributionState {
  const latest = snapshots.at(-1)
  if (latest === undefined) return createEmptyAttributionState()
  return {
    fileStates: new Map(Object.entries(latest.fileStates)),
    sessionBaselines: new Map(),
    surface: latest.surface,
    startingHeadSha: null,
    ...countersFrom(latest),
  }
}

export function attributionRestoreStateFromLog(
  snapshots: AttributionSnapshotMessage[],
  onUpdateState: (state: AttributionState) => void,
): void {
  onUpdateState(restoreAttributionStateFromSnapshots(snapshots))
}

export function incrementPromptCount(
  attribution: AttributionState,
  saveSnapshot: (snapshot: AttributionSnapshotMessage) => void,
): AttributionState {
  const next = { ...attribution, promptCount: attribution.promptCount + 1 }
  saveSnapshot(stateToSnapshotMessage(next, randomUUID()))
  return next
}
