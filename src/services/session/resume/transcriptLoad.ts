/**
 * Resume-side transcript loading.
 *
 * Extracted in Wave 2 of the 11c sessionStorage split. The bulk of resume
 * happens here: read the JSONL (with the lite-skip / preserved-segment dance),
 * parse, then hand the message map to chain.ts for reconstruction.
 *
 * Cross-module dependencies during the split:
 *   - `pure/jsonlStripping.js` — `<persisted-output>` strip and the JSONL
 *     forEach helper (Wave 1).
 *   - `chain.js` — relink + snip + DAG-aware chain building (Wave 2 sibling).
 *   - `src/services/session/sessionStorage.js` — temporary import for the byte-scan
 *     helpers (`scanPreBoundaryMetadata`, `walkChainBeforeParse`). These move
 *     to `indexing/search.ts` in Wave 4; until then they are exported
 *     internal-only from sessionStorage.ts.
 *
 * The runtime circular import is safe: `loadTranscriptFile` is async and is
 * never invoked at module init time, so the partial-init window doesn't
 * matter.
 */
import type { UUID } from 'crypto'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'

import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/platform/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import {
  getOriginalCwd,
  getSessionProjectDir,
} from 'src/platform/bootstrap/state.js'
import type { AgentId } from 'src/types/ids.js'
import type { AttributionSnapshotMessage } from 'src/types/logs.js'
import {
  type ContextCollapseCommitEntry,
  type ContextCollapseSnapshotEntry,
  type Entry,
  type FileHistorySnapshotMessage,
  type PersistedWorktreeSession,
  type TranscriptMessage,
} from 'src/types/logs.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import type { FileHistorySnapshot } from 'src/shared/fs/fileHistory.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { isCompactBoundaryMessage } from 'src/agent/messages/messages.js'
import {
  SKIP_PRECOMPACT_THRESHOLD,
  readTranscriptForLoad,
} from 'src/services/session/sessionStoragePortable.js'
import type { ContentReplacementRecord } from 'src/agent/tools/toolResultStorage.js'
import { getProjectDir } from 'src/services/session/pure/paths.js'
import {
  forEachParsedJSONLBufferEntry,
  stripPersistedToolUseResultsFromJSONLBuffer,
} from 'src/services/session/pure/jsonlStripping.js'
import {
  isLegacyProgressEntry,
  isTranscriptMessage,
} from 'src/services/session/pure/typeGuards.js'
import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
} from 'src/services/session/resume/chain.js'

// Byte-walker primitives live in `indexing/boundaryScan.ts` — shared with
// `indexing/search.ts`. Importing across the resume/indexing boundary is
// intentional and acyclic: boundaryScan has zero deps in the split.
import {
  scanPreBoundaryMetadata,
  walkChainBeforeParse,
} from 'src/services/session/indexing/boundaryScan.js'

/**
 * Loads all messages, summaries, file history snapshots, and attribution snapshots from a specific session file.
 */
export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<UUID>
}> {
  const messages = new Map<UUID, TranscriptMessage>()
  const summaries = new Map<UUID, string>()
  const customTitles = new Map<UUID, string>()
  const tags = new Map<UUID, string>()
  const agentNames = new Map<UUID, string>()
  const agentColors = new Map<UUID, string>()
  const agentSettings = new Map<UUID, string>()
  const prNumbers = new Map<UUID, number>()
  const prUrls = new Map<UUID, string>()
  const prRepositories = new Map<UUID, string>()
  const modes = new Map<UUID, string>()
  const worktreeStates = new Map<UUID, PersistedWorktreeSession | null>()
  const fileHistorySnapshots = new Map<UUID, FileHistorySnapshotMessage>()
  const attributionSnapshots = new Map<UUID, AttributionSnapshotMessage>()
  const contentReplacements = new Map<UUID, ContentReplacementRecord[]>()
  const agentContentReplacements = new Map<
    AgentId,
    ContentReplacementRecord[]
  >()
  // Array, not Map — commit order matters (nested collapses).
  const contextCollapseCommits: ContextCollapseCommitEntry[] = []
  // Last-wins — later entries supersede.
  let contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined

  try {
    // For large transcripts, avoid materializing megabytes of stale content.
    // Single forward chunked read: attribution-snapshot lines are skipped at
    // the fd level (never buffered), compact boundaries truncate the
    // accumulator in-stream. Peak allocation is the OUTPUT size, not the
    // file size — a 151 MB session that is 84% stale attr-snaps allocates
    // ~32 MB instead of 159+64 MB. This matters because mimalloc does not
    // return those pages to the OS even after JS-level GC frees the backing
    // buffers (measured: arrayBuffers=0 after Bun.gc(true) but RSS stuck at
    // ~316 MB on the old scan+strip path vs ~155 MB here).
    //
    // Pre-boundary metadata (agent-setting, mode, pr-link, etc.) is recovered
    // via a cheap byte-level forward scan of [0, boundary).
    let buf: Buffer | null = null
    let metadataLines: string[] | null = null
    let hasPreservedSegment = false
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP)) {
      const { size } = await stat(filePath)
      if (size > SKIP_PRECOMPACT_THRESHOLD) {
        const scan = await readTranscriptForLoad(filePath, size)
        buf = scan.postBoundaryBuf
        hasPreservedSegment = scan.hasPreservedSegment
        // >0 means we truncated pre-boundary bytes and must recover
        // session-scoped metadata from that range. A preservedSegment
        // boundary does not truncate (preserved messages are physically
        // pre-boundary), so offset stays 0 unless an EARLIER non-preserved
        // boundary already truncated — in which case the preserved messages
        // for the later boundary are post-that-earlier-boundary and were
        // kept, and we still want the metadata scan.
        if (scan.boundaryStartOffset > 0) {
          metadataLines = await scanPreBoundaryMetadata(
            filePath,
            scan.boundaryStartOffset,
          )
        }
      }
    }
    buf ??= await readFile(filePath)
    // For large buffers (which here means readTranscriptForLoad output with
    // attr-snaps already stripped at the fd level — the <5MB readFile path
    // falls through the size gate below), the dominant cost is parsing dead
    // fork branches that buildConversationChain would discard anyway. Skip
    // when the caller needs all
    // leaves (loadAllLogsFromSessionFile for /insights picks the branch with
    // most user messages, not the latest), when the boundary has a
    // preservedSegment (those messages keep their pre-compact parentUuid on
    // disk -- applyPreservedSegmentRelinks splices them in-memory AFTER
    // parse, so a pre-parse chain walk would drop them as orphans), and when
    // CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP is set (that kill switch means
    // "load everything, skip nothing"; this is another skip-before-parse
    // optimization and the scan it depends on for hasPreservedSegment did
    // not run).
    if (
      !opts?.keepAllLeaves &&
      !hasPreservedSegment &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP) &&
      buf.length > SKIP_PRECOMPACT_THRESHOLD
    ) {
      buf = walkChainBeforeParse(buf)
    }

    // Resume path: once a tool_result has been replaced with a persisted
    // preview, loading the original toolUseResult blob back into memory is
    // wasted work and can OOM before the replacement re-hydration runs.
    buf = stripPersistedToolUseResultsFromJSONLBuffer(buf)

    // First pass: process metadata-only lines collected during the boundary scan.
    // These populate the session-scoped maps (agentSettings, modes, prNumbers,
    // etc.) for entries written before the compact boundary. Any overlap with
    // the post-boundary buffer is harmless — later values overwrite earlier ones.
    if (metadataLines && metadataLines.length > 0) {
      forEachParsedJSONLBufferEntry<Entry>(
        Buffer.from(metadataLines.join('\n')),
        entry => {
        if (entry.type === 'summary' && entry.leafUuid) {
          summaries.set(entry.leafUuid, entry.summary)
        } else if (entry.type === 'custom-title' && entry.sessionId) {
          customTitles.set(entry.sessionId, entry.customTitle)
        } else if (entry.type === 'tag' && entry.sessionId) {
          tags.set(entry.sessionId, entry.tag)
        } else if (entry.type === 'agent-name' && entry.sessionId) {
          agentNames.set(entry.sessionId, entry.agentName)
        } else if (entry.type === 'agent-color' && entry.sessionId) {
          agentColors.set(entry.sessionId, entry.agentColor)
        } else if (entry.type === 'agent-setting' && entry.sessionId) {
          agentSettings.set(entry.sessionId, entry.agentSetting)
        } else if (entry.type === 'mode' && entry.sessionId) {
          modes.set(entry.sessionId, entry.mode)
        } else if (entry.type === 'worktree-state' && entry.sessionId) {
          worktreeStates.set(entry.sessionId, entry.worktreeSession)
        } else if (entry.type === 'pr-link' && entry.sessionId) {
          prNumbers.set(entry.sessionId, entry.prNumber)
          prUrls.set(entry.sessionId, entry.prUrl)
          prRepositories.set(entry.sessionId, entry.prRepository)
        }
      })
    }

    // Bridge map for legacy progress entries: progress_uuid → progress_parent_uuid.
    // PR #24099 removed progress from isTranscriptMessage, so old transcripts with
    // progress in the parentUuid chain would truncate at buildConversationChain
    // when messages.get(progressUuid) returns undefined. Since transcripts are
    // append-only (parents before children), we record each progress→parent link
    // as we see it, chain-resolving through consecutive progress entries, then
    // rewrite any subsequent message whose parentUuid lands in the bridge.
    const progressBridge = new Map<UUID, UUID | null>()

    forEachParsedJSONLBufferEntry<Entry>(buf, entry => {
      // Legacy progress check runs before the Entry-typed else-if chain —
      // progress is not in the Entry union, so checking it after TypeScript
      // has narrowed `entry` intersects to `never`.
      if (isLegacyProgressEntry(entry)) {
        // Chain-resolve through consecutive progress entries so a later
        // message pointing at the tail of a progress run bridges to the
        // nearest non-progress ancestor in one lookup.
        const parent = entry.parentUuid
        progressBridge.set(
          entry.uuid,
          parent && progressBridge.has(parent)
            ? (progressBridge.get(parent) ?? null)
            : parent,
        )
      } else if (isTranscriptMessage(entry)) {
        if (entry.parentUuid && progressBridge.has(entry.parentUuid)) {
          entry.parentUuid = progressBridge.get(entry.parentUuid) ?? null
        }
        messages.set(entry.uuid, entry)
        // Compact boundary: prior marble-origami-commit entries reference
        // messages that won't be in the post-boundary chain. The >5MB
        // backward-scan path discards them naturally by never reading the
        // pre-boundary bytes; the <5MB path reads everything, so discard
        // here. Without this, getStats().collapsedSpans in /context
        // overcounts (projectView silently skips the stale commits but
        // they're still in the log).
        if (isCompactBoundaryMessage(entry)) {
          contextCollapseCommits.length = 0
          contextCollapseSnapshot = undefined
        }
      } else if (entry.type === 'summary' && entry.leafUuid) {
        summaries.set(entry.leafUuid, entry.summary)
      } else if (entry.type === 'custom-title' && entry.sessionId) {
        customTitles.set(entry.sessionId, entry.customTitle)
      } else if (entry.type === 'tag' && entry.sessionId) {
        tags.set(entry.sessionId, entry.tag)
      } else if (entry.type === 'agent-name' && entry.sessionId) {
        agentNames.set(entry.sessionId, entry.agentName)
      } else if (entry.type === 'agent-color' && entry.sessionId) {
        agentColors.set(entry.sessionId, entry.agentColor)
      } else if (entry.type === 'agent-setting' && entry.sessionId) {
        agentSettings.set(entry.sessionId, entry.agentSetting)
      } else if (entry.type === 'mode' && entry.sessionId) {
        modes.set(entry.sessionId, entry.mode)
      } else if (entry.type === 'worktree-state' && entry.sessionId) {
        worktreeStates.set(entry.sessionId, entry.worktreeSession)
      } else if (entry.type === 'pr-link' && entry.sessionId) {
        prNumbers.set(entry.sessionId, entry.prNumber)
        prUrls.set(entry.sessionId, entry.prUrl)
        prRepositories.set(entry.sessionId, entry.prRepository)
      } else if (entry.type === 'file-history-snapshot') {
        fileHistorySnapshots.set(entry.messageId, entry)
      } else if (entry.type === 'attribution-snapshot') {
        attributionSnapshots.set(entry.messageId, entry)
      } else if (entry.type === 'content-replacement') {
        // Subagent decisions key by agentId (sidechain resume); main-thread
        // decisions key by sessionId (/resume).
        if (entry.agentId) {
          const existing = agentContentReplacements.get(entry.agentId) ?? []
          agentContentReplacements.set(entry.agentId, existing)
          existing.push(...entry.replacements)
        } else {
          const existing = contentReplacements.get(entry.sessionId) ?? []
          contentReplacements.set(entry.sessionId, existing)
          existing.push(...entry.replacements)
        }
      } else if (entry.type === 'marble-origami-commit') {
        contextCollapseCommits.push(entry)
      } else if (entry.type === 'marble-origami-snapshot') {
        contextCollapseSnapshot = entry
      }
    })
  } catch {
    // File doesn't exist or can't be read
  }

  const { relinkFailed } = applyPreservedSegmentRelinks(messages)
  if (relinkFailed) {
    logForDiagnosticsNoPII('warn', 'resume_relink_fail_closed', {
      transcriptSize: messages.size,
    })
  }
  applySnipRemovals(messages)

  // Compute leaf UUIDs once at load time
  // Only user/assistant messages should be considered as leaves for anchoring resume.
  // Other message types (system, attachment) are metadata or auxiliary and shouldn't
  // anchor a conversation chain.
  //
  // We use standard parent relationship for main chain detection, but also need to
  // handle cases where the last message is a system/metadata message.
  // For each conversation chain (identified by following parent links), the leaf
  // is the most recent user/assistant message.
  const allMessages = [...messages.values()]

  // Standard leaf computation using parent relationships
  const parentUuids = new Set(
    allMessages
      .map(msg => msg.parentUuid)
      .filter((uuid): uuid is UUID => uuid !== null),
  )

  // Find all terminal messages (messages with no children)
  const terminalMessages = allMessages.filter(msg => !parentUuids.has(msg.uuid))

  const leafUuids = new Set<UUID>()
  let hasCycle = false

  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_pebble_leaf_prune', false)) {
    // Build a set of UUIDs that have user/assistant children
    // (these are mid-conversation nodes, not dead ends)
    const hasUserAssistantChild = new Set<UUID>()
    for (const msg of allMessages) {
      if (msg.parentUuid && (msg.type === 'user' || msg.type === 'assistant')) {
        hasUserAssistantChild.add(msg.parentUuid)
      }
    }

    // For each terminal message, walk back to find the nearest user/assistant ancestor.
    // Skip ancestors that already have user/assistant children - those are mid-conversation
    // nodes where the conversation continued (e.g., an assistant tool_use message whose
    // progress child is terminal, but whose tool_result child continues the conversation).
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === 'user' || current.type === 'assistant') {
          if (!hasUserAssistantChild.has(current.uuid)) {
            leafUuids.add(current.uuid)
          }
          break
        }
        current = current.parentUuid
          ? messages.get(current.parentUuid)
          : undefined
      }
    }
  } else {
    // Original leaf computation: walk back from terminal messages to find
    // the nearest user/assistant ancestor unconditionally
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === 'user' || current.type === 'assistant') {
          leafUuids.add(current.uuid)
          break
        }
        current = current.parentUuid
          ? messages.get(current.parentUuid)
          : undefined
      }
    }
  }

  if (hasCycle) {
    logEvent('tengu_transcript_parent_cycle', {})
  }

  return {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    worktreeStates,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    agentContentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
    leafUuids,
  }
}

/**
 * Loads all messages, summaries, file history snapshots, and attribution snapshots from a specific session file.
 */
export async function loadSessionFile(sessionId: UUID): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentSettings: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
}> {
  const sessionFile = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
  return loadTranscriptFile(sessionFile)
}

/**
 * Builds a filie history snapshot chain from the conversation
 */
export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  // messageId → last index in snapshots[] for O(1) update lookup
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate
      ? indexByMessageId.get(snapshot.messageId)
      : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * Builds an attribution snapshot chain from the conversation.
 * Unlike file history snapshots, attribution snapshots are returned in full
 * because they use generated UUIDs (not message UUIDs) and represent
 * cumulative state that should be restored on session resume.
 */
export function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  // Return all attribution snapshots - they will be merged during restore
  return Array.from(attributionSnapshots.values())
}
