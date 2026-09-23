import { randomUUID, type UUID } from 'crypto'
import { stat } from 'fs/promises'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import type {
  AttributionSnapshotMessage,
  FileAttributionState,
} from 'src/shared/types/logs.js'
import { resolveGitDir } from 'src/vcs/git/gitFilesystem.js'
import { getCanonicalName, type ModelName } from 'src/providers/model/model.js'

// @[MODEL LAUNCH]: Add a mapping for the new model ID so git commit trailers show the public name.
/**
 * Sanitize a model name to its public equivalent.
 * Maps internal variants to their public names based on model family.
 */
export function sanitizeModelName(shortName: string): string {
  // Map internal variants to public equivalents based on model family
  // Before the fable-5 branch: 'fable-5-1' contains 'fable-5'.
  if (shortName.includes('fable-5-1')) return 'claude-fable-5-1'
  if (shortName.includes('fable-5')) return 'claude-fable-5'
  // Same containment trap one tier down: 'opus-5-5' contains 'opus-5'.
  if (shortName.includes('opus-5-5')) return 'claude-opus-5-5'
  if (shortName.includes('opus-5')) return 'claude-opus-5'
  if (shortName.includes('opus-4-8')) return 'claude-opus-4-8'
  if (shortName.includes('opus-4-7')) return 'claude-opus-4-7'
  if (shortName.includes('opus-4-6')) return 'claude-opus-4-6'
  if (shortName.includes('opus-4-5')) return 'claude-opus-4-5'
  if (shortName.includes('opus-4-1')) return 'claude-opus-4-1'
  if (shortName.includes('opus-4')) return 'claude-opus-4'
  if (shortName.includes('sonnet-5')) return 'claude-sonnet-5'
  if (shortName.includes('sonnet-4-6')) return 'claude-sonnet-4-6'
  if (shortName.includes('sonnet-4-5')) return 'claude-sonnet-4-5'
  if (shortName.includes('sonnet-4')) return 'claude-sonnet-4'
  if (shortName.includes('sonnet-3-7')) return 'claude-sonnet-3-7'
  if (shortName.includes('haiku-4-5')) return 'claude-haiku-4-5'
  if (shortName.includes('haiku-3-5')) return 'claude-haiku-3-5'
  // Unknown models get a generic name
  return 'claude'
}

/**
 * Attribution state for tracking Claude's contributions to files.
 *
 * `fileStates` and `sessionBaselines` are always EMPTY at runtime, and were
 * already empty before the 2026-09-18 dead-code round. Their only writer was
 * `trackFileModification`, which had no caller at any point in this fork's
 * history — the Edit/Write post-hook that upstream calls it from was never
 * wired here — so it was removed as a dead export. The rest of the pipeline is
 * live: `incrementPromptCount` fires from `useOnSubmit` and the headless
 * `controlLoop` on every prompt, `stateToSnapshotMessage` persists the
 * snapshot, and `src/sessions/indexing/liteMetadata.ts` builds a chain from it
 * for the resume index. So the COUNT fields work and the per-file
 * contributions do not.
 *
 * Two honest options, both product decisions rather than cleanup: wire a
 * writer back (`git show fee88d27^:src/vcs/git/commitAttribution.ts` has the
 * deleted implementation), or drop the two map fields and the
 * `FileAttributionState` plumbing under them. Until one is taken, do not read
 * a populated `fileStates` into any new feature.
 */
export type AttributionState = {
  // File states keyed by relative path (from cwd)
  fileStates: Map<string, FileAttributionState>
  // Session baseline states for net change calculation
  sessionBaselines: Map<string, { contentHash: string; mtime: number }>
  // Surface from which edits were made
  surface: string
  // HEAD SHA at session start (for detecting external commits)
  startingHeadSha: string | null
  // Total prompts in session (for steer count calculation)
  promptCount: number
  // Prompts at last commit (to calculate steers for current commit)
  promptCountAtLastCommit: number
  // Permission prompt tracking
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  // ESC press tracking (user cancelled permission prompt)
  escapeCount: number
  escapeCountAtLastCommit: number
}

// The git-notes JSON shape — AttributionData, AttributionSummary and
// FileAttribution — went with the writer that produced it. Nothing in this fork
// writes a git note or reads one back; what survives here is the per-session
// character accounting that the attribution TEXTS are derived from.

/**
 * Get the current client surface from environment.
 */
export function getClientSurface(): string {
  return process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'
}

/**
 * Create an empty attribution state for a new session.
 */
export function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(),
    sessionBaselines: new Map(),
    surface: getClientSurface(),
    startingHeadSha: null,
    promptCount: 0,
    promptCountAtLastCommit: 0,
    permissionPromptCount: 0,
    permissionPromptCountAtLastCommit: 0,
    escapeCount: 0,
    escapeCountAtLastCommit: 0,
  }
}

// formatAttributionTrailer moved to attributionTrailer.ts for tree-shaking
// (contains excluded strings that should not be in external builds)


/**
 * Convert attribution state to snapshot message for persistence.
 */
export function stateToSnapshotMessage(
  state: AttributionState,
  messageId: UUID,
): AttributionSnapshotMessage {
  const fileStates: Record<string, FileAttributionState> = {}

  for (const [path, fileState] of state.fileStates) {
    fileStates[path] = fileState
  }

  return {
    type: 'attribution-snapshot',
    messageId,
    surface: state.surface,
    fileStates,
    promptCount: state.promptCount,
    promptCountAtLastCommit: state.promptCountAtLastCommit,
    permissionPromptCount: state.permissionPromptCount,
    permissionPromptCountAtLastCommit: state.permissionPromptCountAtLastCommit,
    escapeCount: state.escapeCount,
    escapeCountAtLastCommit: state.escapeCountAtLastCommit,
  }
}

/**
 * Restore attribution state from snapshot messages.
 */
export function restoreAttributionStateFromSnapshots(
  snapshots: AttributionSnapshotMessage[],
): AttributionState {
  const state = createEmptyAttributionState()

  // Snapshots are full-state dumps (see stateToSnapshotMessage), not deltas.
  // The last snapshot has the most recent count for every path — fileStates
  // never shrinks. Iterating and SUMMING counts across snapshots causes
  // quadratic growth on restore (837 snapshots × 280 files → 1.15 quadrillion
  // "chars" tracked for a 5KB file over a 5-day session).
  const lastSnapshot = snapshots[snapshots.length - 1]
  if (!lastSnapshot) {
    return state
  }

  state.surface = lastSnapshot.surface
  for (const [path, fileState] of Object.entries(lastSnapshot.fileStates)) {
    state.fileStates.set(path, fileState)
  }

  // Restore prompt counts from the last snapshot (most recent state)
  state.promptCount = lastSnapshot.promptCount ?? 0
  state.promptCountAtLastCommit = lastSnapshot.promptCountAtLastCommit ?? 0
  state.permissionPromptCount = lastSnapshot.permissionPromptCount ?? 0
  state.permissionPromptCountAtLastCommit =
    lastSnapshot.permissionPromptCountAtLastCommit ?? 0
  state.escapeCount = lastSnapshot.escapeCount ?? 0
  state.escapeCountAtLastCommit = lastSnapshot.escapeCountAtLastCommit ?? 0

  return state
}

/**
 * Restore attribution state from log snapshots on session resume.
 */
export function attributionRestoreStateFromLog(
  attributionSnapshots: AttributionSnapshotMessage[],
  onUpdateState: (newState: AttributionState) => void,
): void {
  const state = restoreAttributionStateFromSnapshots(attributionSnapshots)
  onUpdateState(state)
}

/**
 * Increment promptCount and save an attribution snapshot.
 * Used to persist the prompt count across compaction.
 *
 * @param attribution - Current attribution state
 * @param saveSnapshot - Function to save the snapshot (allows async handling by caller)
 * @returns New attribution state with incremented promptCount
 */
export function incrementPromptCount(
  attribution: AttributionState,
  saveSnapshot: (snapshot: AttributionSnapshotMessage) => void,
): AttributionState {
  const newAttribution = {
    ...attribution,
    promptCount: attribution.promptCount + 1,
  }
  const snapshot = stateToSnapshotMessage(newAttribution, randomUUID())
  saveSnapshot(snapshot)
  return newAttribution
}
