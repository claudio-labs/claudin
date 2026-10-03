/**
 * Resume-side chain reconstruction.
 *
 * Extracted in Wave 2 of the 11c sessionStorage split. Public APIs
 * (`buildConversationChain`, `findLatestMessage`, `applySnipRemovals`,
 * `applyPreservedSegmentRelinks`, `recoverOrphanedParallelToolResults`) are
 * re-exported from `src/sessions/sessionStorage.ts` for the duration of the
 * split — see the barrel collapse plan (Wave 5).
 */
import type { UUID } from 'crypto'

import type { SystemCompactBoundaryMessage } from 'src/shared/types/message.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { logError } from 'src/shared/log.js'
import { isCompactBoundaryMessage } from 'src/agent/messages/messages.js'
import { latestByTimestamp } from 'src/sessions/resume/latest.js'

export function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  return latestByTimestamp(messages, predicate)
}

export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const leafFirst: TranscriptMessage[] = []
  const onChain = new Set<UUID>()
  let current: TranscriptMessage | undefined = leafMessage
  while (current) {
    if (onChain.has(current.uuid)) {
      logError(new Error(`Parent loop in transcript chain at ${current.uuid}; the chain stops there`))
      break
    }
    onChain.add(current.uuid)
    leafFirst.push(current)
    current = current.parentUuid ? messages.get(current.parentUuid) : undefined
  }
  return recoverOrphanedParallelToolResults(messages, leafFirst.reverse(), onChain)
}

export function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  const lastBlockOnChain = new Map<string, number>()
  chain.forEach((entry, position) => {
    const response = responseIdOf(entry)
    if (response) lastBlockOnChain.set(response, position)
  })
  if (lastBlockOnChain.size === 0) return chain

  const index = indexTranscript(messages)
  const taken = new Set(seen)
  const after = new Map<number, TranscriptMessage[]>()
  const responses = [...lastBlockOnChain].sort(([, a], [, b]) => a - b)
  for (const [response, position] of responses) {
    const pulled = gatherForResponse(response, index, taken)
    if (pulled.length > 0) after.set(position, pulled)
  }
  if (after.size === 0) return chain
  return chain.flatMap((entry, position) => [entry, ...(after.get(position) ?? [])])
}

function toolUseIdsOf(m: TranscriptMessage): string[] {
  if (m.type !== 'assistant') return []
  return m.message.content.flatMap(b => (b.type === 'tool_use' ? [b.id] : []))
}

/** Where every entry sits in the file, and the links the recovery follows. */
type TranscriptIndex = {
  position: Map<UUID, number>
  blocksOf: Map<string, TranscriptMessage[]>
  childrenOf: Map<UUID, TranscriptMessage[]>
  hooksFor: Map<string, TranscriptMessage[]>
}

function indexTranscript(messages: Map<UUID, TranscriptMessage>): TranscriptIndex {
  const index: TranscriptIndex = {
    position: new Map(),
    blocksOf: new Map(),
    childrenOf: new Map(),
    hooksFor: new Map(),
  }
  for (const entry of messages.values()) {
    index.position.set(entry.uuid, index.position.size)
    const response = responseIdOf(entry)
    if (response) appendTo(index.blocksOf, response, entry)
    if (entry.parentUuid) appendTo(index.childrenOf, entry.parentUuid, entry)
    const call = hookToolUseIdOf(entry)
    if (call) appendTo(index.hooksFor, call, entry)
  }
  return index
}

function appendTo<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key)
  if (group) group.push(value)
  else groups.set(key, [value])
}

/** Streaming writes one entry per content block; the blocks of a reply share its `message.id`. */
function responseIdOf(entry: TranscriptMessage): string | undefined {
  if (entry.type !== 'assistant') return undefined
  return entry.message.id || undefined
}

function hookToolUseIdOf(entry: TranscriptMessage): string | undefined {
  if (entry.type !== 'attachment') return undefined
  const call = (entry.attachment as { toolUseID?: unknown }).toolUseID
  return typeof call === 'string' ? call : undefined
}

function carriesToolResult(entry: TranscriptMessage): boolean {
  if (entry.type !== 'user') return false
  const content = entry.message.content
  return Array.isArray(content) && content.some(block => block.type === 'tool_result')
}

/**
 * What a single-parent walk skipped around one reply: its other blocks, then
 * the results and hook output of its calls and whatever was chained after
 * them. Everything gathered is added to `taken`.
 */
function gatherForResponse(
  response: string,
  index: TranscriptIndex,
  taken: Set<UUID>,
): TranscriptMessage[] {
  const blocks = index.blocksOf.get(response) ?? []
  const skippedBlocks = blocks.filter(block => !taken.has(block.uuid))
  for (const block of skippedBlocks) taken.add(block.uuid)

  const anchors: TranscriptMessage[] = []
  for (const block of blocks) {
    for (const child of index.childrenOf.get(block.uuid) ?? []) {
      if (carriesToolResult(child)) anchors.push(child)
    }
    for (const call of toolUseIdsOf(block)) anchors.push(...(index.hooksFor.get(call) ?? []))
  }
  const followers = collectOffChain(anchors, index, taken)
  return [...inFileOrder(skippedBlocks, index), ...inFileOrder(followers, index)]
}

/** The anchors not yet taken and every entry hanging below them, stopping at taken entries. */
function collectOffChain(
  anchors: TranscriptMessage[],
  index: TranscriptIndex,
  taken: Set<UUID>,
): TranscriptMessage[] {
  const collected: TranscriptMessage[] = []
  const pending = [...anchors]
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (taken.has(next.uuid)) continue
    taken.add(next.uuid)
    collected.push(next)
    pending.push(...(index.childrenOf.get(next.uuid) ?? []))
  }
  return collected
}

function inFileOrder(entries: TranscriptMessage[], index: TranscriptIndex): TranscriptMessage[] {
  const at = (entry: TranscriptMessage) => index.position.get(entry.uuid) ?? Number.MAX_SAFE_INTEGER
  return [...entries].sort((a, b) => at(a) - at(b))
}

type PreservedSegment = NonNullable<SystemCompactBoundaryMessage['compactMetadata']['preservedSegment']>

type CompactBoundaryEntry = TranscriptMessage & SystemCompactBoundaryMessage

function isBoundaryEntry(entry: TranscriptMessage): entry is CompactBoundaryEntry {
  return isCompactBoundaryMessage(entry)
}

type SegmentWalk =
  | { ok: true; members: UUID[] }
  | { ok: false; reason: 'tail_missing' | 'parent_missing' | 'loop' | 'anchor_missing' }

/**
 * Splice preserved-segment pre-compact messages back into the chain.
 *
 * Compact boundaries written with a preservedSegment keep the
 * pre-compact head→tail run physically on disk; this function rewrites
 * parentUuids in-memory so the chain walks through them. Fail-closed: a
 * broken tail→head walk degrades to absolute-boundary pruning instead of
 * loading the full pre-compact history.
 */
export function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): {
  relinkFailed: boolean
} {
  const boundaries = [...messages.values()].filter(isBoundaryEntry)
  if (!boundaries.some(boundary => boundary.compactMetadata?.preservedSegment)) {
    return { relinkFailed: false }
  }
  const lastBoundary = boundaries.at(-1)!
  const live = lastBoundary.compactMetadata?.preservedSegment
  let kept = new Set<UUID>()
  let relinkFailed = false
  if (live) {
    const walk = walkSegment(messages, live)
    if (walk.ok) {
      spliceSegment(messages, live, walk.members)
      kept = new Set(walk.members)
    } else {
      relinkFailed = true
      logForDiagnosticsNoPII('warn', 'resume_preserved_segment_relink_failed', { reason: walk.reason })
    }
  }
  dropBefore(messages, lastBoundary.uuid, kept)
  return { relinkFailed }
}

/** The segment's uuids from tail to head, when every link on the way is there. */
function walkSegment(messages: Map<UUID, TranscriptMessage>, segment: PreservedSegment): SegmentWalk {
  const members: UUID[] = []
  let current = messages.get(segment.tailUuid)
  if (!current) return { ok: false, reason: 'tail_missing' }
  while (current.uuid !== segment.headUuid) {
    if (members.includes(current.uuid)) return { ok: false, reason: 'loop' }
    members.push(current.uuid)
    const parent: TranscriptMessage | undefined = current.parentUuid ? messages.get(current.parentUuid) : undefined
    if (!parent) return { ok: false, reason: 'parent_missing' }
    current = parent
  }
  members.push(current.uuid)
  if (!messages.has(segment.anchorUuid)) return { ok: false, reason: 'anchor_missing' }
  return { ok: true, members }
}

const PRE_COMPACT_TOKEN_COUNTERS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const

function spliceSegment(
  messages: Map<UUID, TranscriptMessage>,
  segment: PreservedSegment,
  members: UUID[],
): void {
  for (const [uuid, entry] of messages) {
    if (uuid !== segment.headUuid && entry.parentUuid === segment.anchorUuid) {
      messages.set(uuid, { ...entry, parentUuid: segment.tailUuid })
    }
  }
  const head = messages.get(segment.headUuid)!
  messages.set(segment.headUuid, { ...head, parentUuid: segment.anchorUuid })
  // The kept replies were billed against the context the compaction dropped;
  // counting those tokens again would misreport the resumed context size.
  for (const uuid of members) {
    const entry = messages.get(uuid)
    if (entry?.type !== 'assistant' || !entry.message.usage) continue
    const usage = { ...entry.message.usage }
    for (const counter of PRE_COMPACT_TOKEN_COUNTERS) usage[counter] = 0
    messages.set(uuid, { ...entry, message: { ...entry.message, usage } })
  }
}

function dropBefore(messages: Map<UUID, TranscriptMessage>, boundary: UUID, kept: Set<UUID>): void {
  for (const uuid of [...messages.keys()]) {
    if (uuid === boundary) return
    if (!kept.has(uuid)) messages.delete(uuid)
  }
}

export function applySnipRemovals(
  messages: Map<UUID, TranscriptMessage>,
): void {
  const snipped = new Set<UUID>()
  for (const entry of messages.values()) {
    for (const uuid of removedUuidsOf(entry)) snipped.add(uuid)
  }
  if (snipped.size === 0) return

  const parentOfSnipped = new Map<UUID, UUID | null>()
  for (const uuid of snipped) {
    const entry = messages.get(uuid)
    if (entry) parentOfSnipped.set(uuid, entry.parentUuid)
    messages.delete(uuid)
  }
  for (const [uuid, entry] of messages) {
    if (entry.parentUuid && snipped.has(entry.parentUuid)) {
      messages.set(uuid, { ...entry, parentUuid: survivingAncestor(entry.parentUuid, parentOfSnipped, messages) })
    }
  }
}

function removedUuidsOf(entry: TranscriptMessage): UUID[] {
  const removed = (entry as { snipMetadata?: { removedUuids?: unknown } }).snipMetadata?.removedUuids
  return Array.isArray(removed) ? removed.filter((uuid): uuid is UUID => typeof uuid === 'string') : []
}

/** Up through snipped entries to the first one still in the map; `null` when the way runs out. */
function survivingAncestor(
  start: UUID,
  parentOfSnipped: Map<UUID, UUID | null>,
  messages: Map<UUID, TranscriptMessage>,
): UUID | null {
  const passed = new Set<UUID>()
  let current: UUID | null | undefined = start
  while (current && parentOfSnipped.has(current) && !passed.has(current)) {
    passed.add(current)
    current = parentOfSnipped.get(current)
  }
  return current && messages.has(current) ? current : null
}
