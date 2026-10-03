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
 *   - `src/sessions/sessionStorage.js` — temporary import for the byte-scan
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
import { z } from 'zod/v4'

import {
  getOriginalCwd,
  getSessionProjectDir,
} from 'src/platform/bootstrap/state.js'
import type { AttributionSnapshotMessage } from 'src/shared/types/logs.js'
import {
  type ContextCollapseCommitEntry,
  type ContextCollapseSnapshotEntry,
  type CostStateEntry,
  type FileHistorySnapshotMessage,
  type PersistedWorktreeSession,
  type TranscriptMessage,
} from 'src/shared/types/logs.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import type { FileHistorySnapshot } from 'src/shared/fs/fileHistory.js'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import {
  SKIP_PRECOMPACT_THRESHOLD,
  readTranscriptForLoad,
} from 'src/sessions/sessionStoragePortable.js'
import { getProjectDir } from 'src/sessions/pure/paths.js'
import {
  forEachParsedJSONLBufferEntry,
  stripPersistedToolUseResultsFromJSONLBuffer,
} from 'src/sessions/pure/jsonlStripping.js'
import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
} from 'src/sessions/resume/chain.js'
import {
  emptyTranscript,
  findTips,
  type LoadedTranscript,
  TranscriptCollector,
} from 'src/sessions/resume/transcriptFile.js'

// Byte-walker primitives live in `indexing/boundaryScan.ts` — shared with
// `indexing/search.ts`. Importing across the resume/indexing boundary is
// intentional and acyclic: boundaryScan has zero deps in the split.
import {
  scanPreBoundaryMetadata,
  walkChainBeforeParse,
} from 'src/sessions/indexing/boundaryScan.js'

// Model names are keys a terminal prints (/cost): no control or format chars.
const COST_STATE_MODEL_NAME_RE = /^[^\p{Cc}\p{Cf}]+$/u

/**
 * Claude Code's own check of a `cost-state` line (2.1.280). A line that
 * fails it is skipped, so the last VALID entry wins and a corrupt or
 * hand-edited one cannot restore a negative or absurd cost.
 */
const costStateEntrySchema = lazySchema(() => {
  const amount = z.number().nonnegative()
  return z.object({
    type: z.literal('cost-state'),
    sessionId: z.string(),
    totalCostUSD: amount.max(1e9),
    totalAPIDuration: amount,
    totalAPIDurationWithoutRetries: amount,
    totalToolDuration: amount,
    totalLinesAdded: amount,
    totalLinesRemoved: amount,
    totalDuration: amount,
    startTime: amount,
    modelUsage: z.record(
      z.string().regex(COST_STATE_MODEL_NAME_RE),
      z.object({
        inputTokens: amount,
        outputTokens: amount,
        cacheReadInputTokens: amount,
        cacheCreationInputTokens: amount,
        webSearchRequests: amount,
        costUSD: amount,
      }),
    ),
    hasUnknownModelCost: z.boolean().optional(),
  })
})

function parseCostStateEntry(entry: unknown): CostStateEntry | undefined {
  const parsed = costStateEntrySchema().safeParse(entry)
  return parsed.success ? (parsed.data as CostStateEntry) : undefined
}

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
  costStates: Map<UUID, CostStateEntry>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<UUID>
}> {
  const collector = new TranscriptCollector({ parseCostState: parseCostStateEntry })
  try {
    const bytes = await readForParse(filePath, collector, opts?.keepAllLeaves === true)
    forEachParsedJSONLBufferEntry(stripPersistedToolUseResultsFromJSONLBuffer(bytes), line => collector.take(line))
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return emptyTranscript()
  }
  return replayed(collector.transcript)
}

/**
 * The bytes to parse. A transcript over the threshold is read from its last
 * compact boundary on, the metadata written before the cut going to the
 * collector first; when even that is too large, the branches off the latest
 * chain are left out, unless the caller wants every tip or a preserved
 * segment still has to be spliced in.
 */
async function readForParse(
  filePath: string,
  collector: TranscriptCollector,
  keepAllLeaves: boolean,
): Promise<Buffer> {
  const { size } = await stat(filePath)
  if (size <= SKIP_PRECOMPACT_THRESHOLD || isEnvTruthy(process.env.CLAUDIN_DISABLE_PRECOMPACT_SKIP)) {
    return readFile(filePath)
  }
  const cut = await readTranscriptForLoad(filePath, size)
  if (cut.boundaryStartOffset > 0) {
    const before = await scanPreBoundaryMetadata(filePath, cut.boundaryStartOffset)
    forEachParsedJSONLBufferEntry(Buffer.from(before.join('\n')), line => collector.takeMetadata(line))
  }
  const kept = cut.postBoundaryBuf
  const skipAbandoned = !keepAllLeaves && !cut.hasPreservedSegment && kept.length > SKIP_PRECOMPACT_THRESHOLD
  return skipAbandoned ? walkChainBeforeParse(kept) : kept
}

function replayed(transcript: LoadedTranscript): LoadedTranscript {
  applyPreservedSegmentRelinks(transcript.messages)
  applySnipRemovals(transcript.messages)
  transcript.leafUuids = findTips(transcript.messages)
  return transcript
}

export async function loadSessionFile(sessionId: UUID): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentSettings: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  costStates: Map<UUID, CostStateEntry>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
}> {
  const directory = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return loadTranscriptFile(join(directory, `${sessionId}.jsonl`))
}

export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const chain: FileHistorySnapshot[] = []
  for (const { uuid } of conversation) {
    const entry = fileHistorySnapshots.get(uuid)
    if (!entry) continue
    const replaced = entry.isSnapshotUpdate
      ? chain.findLastIndex(snapshot => snapshot.messageId === entry.snapshot.messageId)
      : -1
    if (replaced === -1) chain.push(entry.snapshot)
    else chain[replaced] = entry.snapshot
  }
  return chain
}

export function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  return [...attributionSnapshots.values()]
}
