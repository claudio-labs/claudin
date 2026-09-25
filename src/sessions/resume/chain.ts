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
import { logForDebugging } from 'src/shared/debug.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { logError } from 'src/shared/log.js'
import { isCompactBoundaryMessage } from 'src/agent/messages/messages.js'

/**
 * O(n) single-pass: find the message with the latest timestamp matching a predicate.
 * Replaces the `[...values].filter(pred).sort((a,b) => Date(b)-Date(a))[0]` pattern
 * which is O(n log n) + 2n Date allocations.
 */
export function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) continue
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * Builds a conversation chain from a leaf message to root
 * @param messages Map of all messages
 * @param leafMessage The leaf message to start from
 * @returns Array of messages from root to leaf
 */
export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg: TranscriptMessage | undefined = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      logError(
        new Error(
          `Cycle detected in parentUuid chain at message ${currentMsg.uuid}. Returning partial transcript.`,
        ),
      )
      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid
      ? messages.get(currentMsg.parentUuid)
      : undefined
  }
  transcript.reverse()
  return recoverOrphanedParallelToolResults(messages, transcript, seen)
}

/**
 * Post-pass for buildConversationChain: recover sibling assistant blocks,
 * tool_results and the rest of each tool call's messages that the
 * single-parent walk orphaned.
 *
 * Streaming (claude.ts:~2024) emits one AssistantMessage per content_block_stop
 * — N parallel tool_uses → N messages, distinct uuid, same message.id. Each
 * tool_result's sourceToolAssistantUUID points to its own one-block assistant,
 * so insertMessageChain's override (line ~894) writes each TR's parentUuid to a
 * DIFFERENT assistant. The topology is a DAG; the walk above is a linked-list
 * traversal and keeps only one branch.
 *
 * Three loss modes observed in production (all fixed here):
 *   1. Sibling assistant orphaned: walk goes prev→asstA→TR_A→next, drops asstB
 *      (same message.id, chained off asstA) and TR_B.
 *   2. Progress-fork (legacy, pre-#23537): each tool_use asst had a progress
 *      child (continued the write chain) AND a TR child. Walk followed
 *      progress; TRs were dropped. No longer written (progress removed from
 *      transcript persistence), but old transcripts still have this shape.
 *   3. Messages written around a TR: a tool call's messages are written as
 *      one run — PreToolUse hook output, the TR, then PostToolUse output and
 *      the tool's own extra messages — each chained to the entry before it.
 *      The TR jumps back to its assistant, so PreToolUse output is left a
 *      dead-end sibling of it, and the rest of the run hangs off a TR the
 *      walk may not take: with parallel calls only the last-written run
 *      survived. Live, that output was folded into the tool_result the model
 *      received, so resume re-sent the block with different bytes.
 *
 * Read-side fix: the write topology is already on disk for old transcripts;
 * this recovery pass handles them.
 */
export function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  type ChainAssistant = Extract<TranscriptMessage, { type: 'assistant' }>
  const chainAssistants = chain.filter(
    (m): m is ChainAssistant => m.type === 'assistant',
  )
  if (chainAssistants.length === 0) return chain

  // Anchor = last on-chain member of each sibling group. chainAssistants is
  // already in chain order, so later iterations overwrite → last wins.
  const anchorByMsgId = new Map<string, ChainAssistant>()
  for (const a of chainAssistants) {
    if (a.message.id) anchorByMsgId.set(a.message.id, a)
  }

  // O(n) precompute: sibling groups, TR index, hook output and children.
  // TRs indexed by parentUuid — insertMessageChain:~894 already wrote that
  // as the srcUUID, and --fork-session strips srcUUID but keeps parentUuid.
  // Hook output names the tool call it is about (toolUseID); the rest of a
  // run is reachable only through its parent.
  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<UUID, TranscriptMessage[]>()
  const hookOutputByToolUseId = new Map<string, TranscriptMessage[]>()
  const childrenByParent = new Map<UUID, TranscriptMessage[]>()
  const addTo = <K>(index: Map<K, TranscriptMessage[]>, key: K, m: TranscriptMessage) => {
    const group = index.get(key)
    if (group) group.push(m)
    else index.set(key, [m])
  }
  // The map's order is JSONL write order (loadTranscriptFile inserts as it
  // parses) — the order the live process sent these messages in.
  const writeOrder = new Map<UUID, number>()
  for (const m of messages.values()) {
    writeOrder.set(m.uuid, writeOrder.size)
    if (m.parentUuid) addTo(childrenByParent, m.parentUuid, m)
    if (m.type === 'assistant' && m.message.id) {
      addTo(siblingsByMsgId, m.message.id, m)
    } else if (
      m.type === 'user' &&
      m.parentUuid &&
      Array.isArray(m.message.content) &&
      m.message.content.some((b: { type: string }) => b.type === 'tool_result')
    ) {
      addTo(toolResultsByAsst, m.parentUuid, m)
    } else if (m.type === 'attachment' && 'toolUseID' in m.attachment) {
      addTo(hookOutputByToolUseId, m.attachment.toolUseID, m)
    }
  }

  // For each message.id group touching the chain: collect off-chain siblings,
  // then the off-chain runs of ALL members. Splice right after the last
  // on-chain member so the group stays contiguous for normalizeMessagesForAPI's
  // merge and every TR lands after its tool_use. When the response's blocks
  // were all written before its first result, that is also the live order:
  // the walk leaves the group at the last result written, so everything it
  // took after the splice point was written after everything recovered.
  const processedGroups = new Set<string>()
  const inserts = new Map<UUID, TranscriptMessage[]>()
  let recoveredCount = 0
  for (const asst of chainAssistants) {
    const msgId = asst.message.id
    if (!msgId || processedGroups.has(msgId)) continue
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [asst]
    const orphanedSiblings = group.filter(s => !seen.has(s.uuid))
    for (const s of orphanedSiblings) seen.add(s.uuid)
    const orphanedRuns: TranscriptMessage[] = []
    const claim = (m: TranscriptMessage) => {
      if (seen.has(m.uuid)) return
      seen.add(m.uuid)
      orphanedRuns.push(m)
    }
    for (const member of group) {
      for (const tr of toolResultsByAsst.get(member.uuid) ?? []) claim(tr)
      for (const toolUseId of toolUseIdsOf(member)) {
        for (const hook of hookOutputByToolUseId.get(toolUseId) ?? []) claim(hook)
      }
    }
    // Then whatever was written after any of those before the next TR jumped
    // back to its assistant. An entry the walk skipped has no descendant it
    // took (every walked entry's parent is walked), so this never pulls in
    // the chain itself. Grows while iterated: children are claimed in turn.
    for (let i = 0; i < orphanedRuns.length; i++) {
      for (const child of childrenByParent.get(orphanedRuns[i]!.uuid) ?? []) claim(child)
    }
    if (orphanedSiblings.length === 0 && orphanedRuns.length === 0) continue

    // Write order only. Timestamps say when an entry was created, not when
    // it was sent: parallel results routinely share a millisecond (sorted by
    // time, a batch was re-sent in a different order than the live process
    // had — a prompt-cache miss from that block on, 2026-09-23), and a hook
    // entry is created when its hook runs but written with its tool's run.
    const byWriteOrder = (a: TranscriptMessage, b: TranscriptMessage) =>
      writeOrder.get(a.uuid)! - writeOrder.get(b.uuid)!
    orphanedSiblings.sort(byWriteOrder)
    orphanedRuns.sort(byWriteOrder)

    const anchor = anchorByMsgId.get(msgId)!
    const recovered = [...orphanedSiblings, ...orphanedRuns]
    recoveredCount += recovered.length
    inserts.set(anchor.uuid, recovered)
  }

  if (recoveredCount === 0) return chain

  const result: TranscriptMessage[] = []
  for (const m of chain) {
    result.push(m)
    const toInsert = inserts.get(m.uuid)
    if (toInsert) result.push(...toInsert)
  }
  return result
}

function toolUseIdsOf(m: TranscriptMessage): string[] {
  if (m.type !== 'assistant') return []
  return m.message.content.flatMap(b => (b.type === 'tool_use' ? [b.id] : []))
}

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
  let relinkFailed = false
  type Seg = NonNullable<
    SystemCompactBoundaryMessage['compactMetadata']['preservedSegment']
  >

  // Find the absolute-last boundary and the last seg-boundary (can differ:
  // manual /compact after reactive compact → seg is stale).
  let lastSeg: Seg | undefined
  let lastSegBoundaryIdx = -1
  let absoluteLastBoundaryIdx = -1
  const entryIndex = new Map<UUID, number>()
  let i = 0
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid, i)
    if (isCompactBoundaryMessage(entry)) {
      absoluteLastBoundaryIdx = i
      const seg = entry.compactMetadata?.preservedSegment
      if (seg) {
        lastSeg = seg
        lastSegBoundaryIdx = i
      }
    }
    i++
  }
  // No seg anywhere → no-op. findUnresolvedToolUse etc. read the full map.
  if (!lastSeg) return { relinkFailed }

  // Seg stale (no-seg boundary came after): skip relink, still prune at
  // absolute — otherwise the stale preserved chain becomes a phantom leaf.
  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx

  // Validate tail→head BEFORE mutating so malformed metadata never keeps
  // the full pre-compact history alive on resume. If the walk breaks, mark
  // the relink as failed and fall through to absolute-boundary pruning.
  const preservedUuids = new Set<UUID>()
  if (segIsLive) {
    const walkSeen = new Set<UUID>()
    const tailInTranscript = messages.has(lastSeg.tailUuid)
    const headInTranscript = messages.has(lastSeg.headUuid)
    const anchorInTranscript = messages.has(lastSeg.anchorUuid)
    let cur = messages.get(lastSeg.tailUuid)
    let reachedHead = false
    let failureKind:
      | 'missing_tail'
      | 'missing_parent'
      | 'null_parent_before_head'
      | 'cycle_before_head'
      | 'missing_anchor' = 'missing_tail'
    let lastSeenUuid: UUID | undefined
    let lastSeenType: TranscriptMessage['type'] | undefined
    let breakParentUuid: UUID | null | undefined

    while (cur) {
      if (walkSeen.has(cur.uuid)) {
        failureKind = 'cycle_before_head'
        break
      }
      walkSeen.add(cur.uuid)
      preservedUuids.add(cur.uuid)
      lastSeenUuid = cur.uuid
      lastSeenType = cur.type
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      breakParentUuid = cur.parentUuid
      if (!breakParentUuid) {
        failureKind = 'null_parent_before_head'
        break
      }
      const next = messages.get(breakParentUuid)
      if (!next) {
        failureKind = 'missing_parent'
        break
      }
      cur = next
    }

    if (!reachedHead || !anchorInTranscript) {
      if (!anchorInTranscript && reachedHead) {
        failureKind = 'missing_anchor'
      }
      // tail→head walk broke — a UUID in the preserved segment isn't in the
      // transcript. Fail closed: keep only the post-boundary chain instead of
      // loading the full pre-compact history on resume.
      relinkFailed = true
      preservedUuids.clear()
      logForDiagnosticsNoPII('warn', 'relink_walk_broken', {
        failureKind,
        tailInTranscript,
        headInTranscript,
        anchorInTranscript,
        walkSteps: walkSeen.size,
        transcriptSize: messages.size,
      })
      logForDebugging(
        `[sessionStorage] preserved-segment relink failed: kind=${failureKind} tail=${lastSeg.tailUuid} head=${lastSeg.headUuid} anchor=${lastSeg.anchorUuid} lastSeen=${lastSeenUuid ?? 'none'} breakParent=${breakParentUuid ?? 'null'}`,
      )
    }
  }

  if (segIsLive && !relinkFailed) {
    const head = messages.get(lastSeg.headUuid)
    if (head) {
      messages.set(lastSeg.headUuid, {
        ...head,
        parentUuid: lastSeg.anchorUuid,
      })
    }
    // Tail-splice: anchor's other children → tail. No-op if already pointing
    // at tail (the useLogMessages race case).
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        messages.set(uuid, { ...msg, parentUuid: lastSeg.tailUuid })
      }
    }
    // Zero stale usage: on-disk input_tokens reflect pre-compact context
    // (~190K) — stripStaleUsage only patched in-memory copies that were
    // dedup-skipped. Without this, resume → immediate autocompact spiral.
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid)
      if (msg?.type !== 'assistant') continue
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message,
          usage: {
            ...msg.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    }
  }

  // Prune everything physically before the absolute-last boundary that
  // isn't preserved. preservedUuids empty when !segIsLive → full prune.
  const toDelete: UUID[] = []
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid)
    if (
      idx !== undefined &&
      idx < absoluteLastBoundaryIdx &&
      !preservedUuids.has(uuid)
    ) {
      toDelete.push(uuid)
    }
  }
  for (const uuid of toDelete) messages.delete(uuid)
  return { relinkFailed }
}

/**
 * Delete messages that Snip executions removed from the in-memory array,
 * and relink parentUuid across the gaps.
 *
 * Unlike compact_boundary which truncates a prefix, snip removes
 * middle ranges. The JSONL is append-only, so removed messages stay on disk
 * and the surviving messages' parentUuid chains walk through them. Without
 * this filter, buildConversationChain reconstructs the full unsnipped history
 * and resume immediately PTLs (adamr-20260320-165831: 397K displayed → 1.65M
 * actual).
 *
 * Deleting alone is not enough: the surviving message AFTER a removed range
 * has parentUuid pointing INTO the gap. buildConversationChain would hit
 * messages.get(undefined) and stop, orphaning everything before the gap. So
 * after delete we relink: for each survivor with a dangling parentUuid, walk
 * backward through the removed region's own parent links to the first
 * non-removed ancestor.
 *
 * The boundary records removedUuids at execution time so we can replay the
 * exact removal on load. Older boundaries without removedUuids are skipped —
 * resume loads their pre-snip history (the pre-fix behavior).
 *
 * Mutates the Map in place.
 */
export function applySnipRemovals(
  messages: Map<UUID, TranscriptMessage>,
): void {
  // Structural check — snipMetadata only exists on the boundary subtype.
  // Avoids the subtype literal which is in excluded-strings.txt
  // (HISTORY_SNIP is internal-only; the literal must not leak into external builds).
  type WithSnipMeta = { snipMetadata?: { removedUuids?: UUID[] } }
  const toDelete = new Set<UUID>()
  for (const entry of messages.values()) {
    const removedUuids = (entry as WithSnipMeta).snipMetadata?.removedUuids
    if (!removedUuids) continue
    for (const uuid of removedUuids) toDelete.add(uuid)
  }
  if (toDelete.size === 0) return

  // Capture each to-delete entry's own parentUuid BEFORE deleting so we can
  // walk backward through contiguous removed ranges. Entries not in the Map
  // (already absent, e.g. from a prior compact_boundary prune) contribute no
  // link; the relink walk will stop at the gap and pick up null (chain-root
  // behavior — same as if compact truncated there, which it did).
  const deletedParent = new Map<UUID, UUID | null>()
  for (const uuid of toDelete) {
    const entry = messages.get(uuid)
    if (!entry) continue
    deletedParent.set(uuid, entry.parentUuid)
    messages.delete(uuid)
  }

  // Relink survivors with dangling parentUuid. Walk backward through
  // deletedParent until we hit a UUID not in toDelete (or null). Path
  // compression: after resolving, seed the map with the resolved link so
  // subsequent survivors sharing the same chain segment don't re-walk.
  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = []
    let cur: UUID | null | undefined = start
    while (cur && toDelete.has(cur)) {
      path.push(cur)
      cur = deletedParent.get(cur)
      if (cur === undefined) {
        cur = null
        break
      }
    }
    for (const p of path) deletedParent.set(p, cur)
    return cur
  }
  for (const [uuid, msg] of messages) {
    if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) continue
    messages.set(uuid, { ...msg, parentUuid: resolve(msg.parentUuid) })
  }
}
