/**
 * Stable-stub tool_result compression.
 *
 * Anthropic prompt cache uses prefix matching: any byte change mid-sequence
 * invalidates the cache from that position onward. The earlier tiered
 * compressor recomputed every turn — fine for stateless shims, fatal for
 * cached prefixes.
 *
 * Stable-stub strategy: maintain a per-(session, agent) monotonic Set<string>
 * of clipped tool_use_ids. Once an id is in the set, the corresponding
 * tool_result content is ALWAYS rewritten to the same deterministic stub
 * bytes. After the first turn that adds an id, every subsequent turn produces
 * identical bytes for that block → prefix cache stays warm. Cache breaks ONCE
 * per "clip event", then stabilizes.
 *
 * Per-(session, agent) keying ensures:
 *   - /resume / switchSession gets a fresh, empty set
 *   - /clear (regenerateSessionId) gets a fresh, empty set
 *   - gRPC headless multi-client clients don't share state
 *   - Sub-agents in a swarm have isolated sets from the parent — a sub-agent
 *     post-autocompact reset cannot wipe the parent's mid-flight state.
 *
 * Works on every provider: Anthropic native, Bedrock, Vertex, OpenAI shims,
 * Codex shim.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getSessionId, onSessionSwitch } from '../../bootstrap/state.js'
import { getAgentId } from '../../utils/teammate.js'
import { estimateImageTokens } from '../../utils/imageTokenEstimator.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'

/** Minimum token count for a tool_result to be immediately stubbed on display. */
const IMMEDIATE_STUB_TOKEN_THRESHOLD = 2000

const DOCUMENT_TOKEN_FALLBACK = 2000

// Worst-case cap on the number of (session, agent) entries we hold. The
// onSessionSwitch listener drops the outgoing session's entry, so in practice
// the Map stays at 1-2 entries; this is a defensive upper bound for pathological
// resume/regenerate loops or untracked headless clients.
const MAX_TRACKED_KEYS = 16

const perKeyClippedIds = new Map<string, Set<string>>()

// Composite key isolates sub-agents (same sessionId, different agentId) from
// the parent. Standalone sessions key on sessionId alone.
function currentKey(): string {
  const sid = getSessionId()
  const agentId = getAgentId()
  return agentId ? `${sid}:${agentId}` : sid
}

function getOrCreateForCurrent(): Set<string> {
  const key = currentKey()
  let set = perKeyClippedIds.get(key)
  if (!set) {
    set = new Set()
    // Simple LRU-ish eviction: drop the oldest insertion-order entry once we
    // exceed the cap. The listener should keep this rare.
    if (perKeyClippedIds.size >= MAX_TRACKED_KEYS) {
      const oldest = perKeyClippedIds.keys().next().value
      if (oldest !== undefined) perKeyClippedIds.delete(oldest)
    }
    perKeyClippedIds.set(key, set)
  }
  return set
}

export function getClippedIds(): ReadonlySet<string> {
  const set = perKeyClippedIds.get(currentKey())
  return set ?? EMPTY_SET
}

const EMPTY_SET: ReadonlySet<string> = new Set()

export function addClippedIds(ids: Iterable<string>): void {
  const set = getOrCreateForCurrent()
  for (const id of ids) {
    set.add(id)
  }
}

export function resetClippedIds(): void {
  perKeyClippedIds.delete(currentKey())
}

/**
 * Remove perKeyClippedIds entries for keys that don't match the current
 * session/agent. After compaction, old session keys from /resume or
 * session-switch scenarios hold stale IDs whose messages no longer exist.
 * The onSessionSwitch listener handles the common case, but compaction
 * can leave orphaned sub-agent keys.
 */
export function pruneStaleClippedIds(): void {
  const key = currentKey()
  for (const k of perKeyClippedIds.keys()) {
    if (k !== key) perKeyClippedIds.delete(k)
  }
}

/**
 * Prune clipped IDs from the current key that no longer exist in the
 * message array (e.g. after compaction removed their messages). Without
 * this, the Set for the current key grows monotonically with IDs whose
 * messages were compacted away.
 */
export function pruneOrphanClippedIds(messages: AnyMessage[]): void {
  const ids = perKeyClippedIds.get(currentKey())
  if (!ids || ids.size === 0) return

  const liveIds = new Set<string>()
  for (const msg of messages) {
    const inner = getInner(msg)
    const role = inner.role ?? msg.role
    if (role === 'assistant') {
      const content = inner.content
      if (Array.isArray(content)) {
        for (const block of content as ToolUseBlock[]) {
          if (block?.type === 'tool_use' && block.id) liveIds.add(block.id)
        }
      }
    }
    if (role === 'user') {
      const content = inner.content
      if (Array.isArray(content)) {
        for (const block of content as AnyContentBlock[]) {
          if (block?.type === 'tool_result' && block.tool_use_id)
            liveIds.add(block.tool_use_id)
        }
      }
    }
  }

  for (const id of ids) {
    if (!liveIds.has(id)) ids.delete(id)
  }
}

// Test-only: reset all tracked keys. Useful for unit tests that mock
// getSessionId across a single test run.
export function _resetAllClippedIdsForTesting(): void {
  perKeyClippedIds.clear()
}

// Test-only: peek at the Map size. Used by tests asserting bounded growth.
export function _getClippedIdsMapSizeForTesting(): number {
  return perKeyClippedIds.size
}

// Test-only: sum of clipped-id counts across all tracked keys.
// Used by the turn-by-turn memory bench to detect when individual
// session buckets grow unbounded (the Map-size cap of 16 can hide
// per-bucket growth).
export function _getClippedIdsTotalCountForTesting(): number {
  let total = 0
  for (const ids of perKeyClippedIds.values()) total += ids.size
  return total
}

// Drop the outgoing session's entries when sessionSwitched fires. We delete
// every key that starts with the OLD sessionId so sub-agent entries for that
// session are reclaimed too. Subscribed once at module load.
let lastSeenSessionId: string | undefined
onSessionSwitch(newId => {
  const old = lastSeenSessionId ?? newId
  lastSeenSessionId = newId
  if (old === newId) return
  for (const k of perKeyClippedIds.keys()) {
    if (k === old || k.startsWith(`${old}:`)) {
      perKeyClippedIds.delete(k)
    }
  }
})

// Mirrors microCompact.calculateToolResultTokens but works on the loose
// tool_result shape that flows through both Anthropic-native and shim paths.
function estimateToolResultTokens(content: unknown): number {
  if (content == null) return 0
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const item of content as Array<{
    type?: string
    text?: string
    source?: unknown
  }>) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'text' && typeof item.text === 'string') {
      total += roughTokenCountEstimation(item.text)
    } else if (item.type === 'image' && item.source) {
      total += estimateImageTokens(item.source as Parameters<typeof estimateImageTokens>[0])
    } else if (item.type === 'document') {
      total += DOCUMENT_TOKEN_FALLBACK
    }
  }
  return total
}

type ToolUseBlock = {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

type AnyContentBlock = {
  type?: string
  tool_use_id?: string
  [k: string]: unknown
}

export type AnyMessage = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

function getInner(msg: AnyMessage): { role?: string; content?: unknown } {
  return msg.message ?? msg
}

function indexToolUses(messages: readonly AnyMessage[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const msg of messages) {
    const inner = getInner(msg)
    const role = inner.role ?? msg.role
    if (role !== 'assistant') continue
    const content = inner.content
    if (!Array.isArray(content)) continue
    for (const block of content as ToolUseBlock[]) {
      if (block?.type === 'tool_use' && block.id) {
        out.set(block.id, block.name ?? 'tool')
      }
    }
  }
  return out
}

/**
 * Build the deterministic stub string for a clipped tool_result.
 *
 * Format: `[clipped: ~N tokens from <toolName>]`
 *
 * CRITICAL: This must be byte-stable across turns for the same (id, content)
 * pair. Do NOT include timestamps, random values, or anything dynamic.
 *
 * Token rounding intentionally NOT applied: the CLIP_STUB_PATTERN guard in
 * applyStableStubs ensures we never recompute tokens for an already-stubbed
 * block, so estimator drift between turns is moot. The exact integer is fine.
 */
export function buildClipStub(toolName: string, originalTokens: number): string {
  return `[clipped: ~${Math.max(0, Math.round(originalTokens))} tokens from ${toolName}]`
}

/**
 * Immediately stub large tool_result content for the display array.
 *
 * When a tool_result arrives during streaming, its full content is stored
 * in QueryEngine.mutableMessages (API-facing) and the transcript. The
 * display array (React state) only needs the content for rendering, and
 * once the tool_result block is committed the user has already seen the
 * output. This function replaces large tool_result content with a clip
 * stub immediately, preventing mid-turn memory spikes.
 *
 * Only stubs content above IMMEDIATE_STUB_TOKEN_THRESHOLD (~2000 tokens).
 * Small results (errors, short outputs) are left intact for scrollback.
 *
 * @param message A user message containing tool_result blocks
 * @param allMessages Current messages array (used to look up tool names)
 * @returns The same message reference if nothing was stubbed, or a new
 *          message with stubbed content
 */
export function stubToolResultForDisplay<T extends AnyMessage>(
  message: T,
  allMessages: T[],
): T {
  const inner = getInner(message)
  const role = inner.role ?? (message as AnyMessage).role
  if (role !== 'user') return message

  const content = inner.content
  if (!Array.isArray(content)) return message

  let anyStubbed = false
  const newContent = (content as AnyContentBlock[]).map(block => {
    if (block?.type !== 'tool_result') return block

    const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? ''
    const existing = (block as { content?: unknown }).content

    // Already stubbed
    if (typeof existing === 'string' && CLIP_STUB_PATTERN.test(existing)) return block

    // Skip non-string content
    if (typeof existing !== 'string') return block

    // Skip if already in clippedIds (microcompact will handle it)
    if (getClippedIds().has(toolUseId)) return block

    // Estimate tokens and check threshold
    const tokens = roughTokenCountEstimation(existing)
    if (tokens < IMMEDIATE_STUB_TOKEN_THRESHOLD) return block

    // Look up the tool name from the preceding assistant message's tool_use block
    const toolName = findToolNameById(allMessages, toolUseId)
    anyStubbed = true
    return {
      ...block,
      content: buildClipStub(toolName, tokens),
    } as AnyContentBlock
  })

  if (!anyStubbed) return message

  // Preserve the .message wrapper if present (same pattern as
  // applyStableStubs / pruneOldToolResults)
  if ((message as { message?: unknown }).message) {
    return {
      ...message,
      message: { ...inner, content: newContent },
    } as T
  }
  return { ...message, content: newContent } as T
}

/** Find the tool name for a given tool_use_id by scanning assistant messages. */
function findToolNameById<T extends AnyMessage>(
  messages: T[],
  toolUseId: string,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role !== 'assistant') continue
    const content = inner.content
    if (!Array.isArray(content)) continue
    for (const block of content as AnyContentBlock[]) {
      if (block?.type === 'tool_use' && (block as ToolUseBlock).id === toolUseId) {
        return (block as ToolUseBlock).name ?? 'tool'
      }
    }
  }
  return 'tool'
}

// Used to detect blocks already rewritten on a previous turn so applyStableStubs
// doesn't recompute the token count from the short stub itself (which would
// drift to a smaller number and break byte-stability).
const CLIP_STUB_PATTERN = /^\[clipped: ~\d+ tokens from .+\]$/

function arrayContainsImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const item of content as Array<{ type?: string }>) {
    if (item && typeof item === 'object' && item.type === 'image') return true
  }
  return false
}

/**
 * Attempt to rewrite a single tool_result block as a clip stub.
 * Returns the original block unchanged when: already a stub, empty, or
 * image-bearing. Callers are responsible for any additional pre-filters
 * (e.g. clippedIds membership check in applyStableStubs).
 */
function stubOneBlock(
  block: AnyContentBlock,
  toolNames: Map<string, string>,
): AnyContentBlock {
  if (block?.type !== 'tool_result') return block
  const existing = (block as ToolResultBlockParam).content
  if (typeof existing === 'string' && CLIP_STUB_PATTERN.test(existing)) return block
  if (existing == null || existing === '') return block
  if (Array.isArray(existing) && existing.length === 0) return block
  if (arrayContainsImage(existing)) return block
  const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? ''
  return {
    ...block,
    content: buildClipStub(toolNames.get(toolUseId) ?? 'tool', estimateToolResultTokens(existing)),
  }
}

/**
 * Walk messages and rewrite every tool_result whose tool_use_id is in the
 * current (session, agent)'s clipped-ids set. Returns the input array
 * reference (identity-preserving fast path) in two no-op cases:
 *   1. The clipped set is empty.
 *   2. The clipped set is non-empty but no message contains a matching
 *      tool_result, OR every match is already a stub.
 * The QueryEngine.submitMessage substitution (roadmap 5.7) and other hot-path
 * callers rely on this so they can guard reassignment with a `=== input` check.
 *
 * Image-bearing trade-off: tool_results whose content is an array containing
 * an `image` block are SKIPPED — we leave them untouched on this turn so
 * vision context isn't silently dropped. (The id stays in the set; if a
 * subsequent turn replaces the content with text-only, it'll be stubbed
 * normally.)
 */
export function applyStableStubs<T extends AnyMessage>(messages: T[]): T[] {
  const clippedIds = perKeyClippedIds.get(currentKey())
  if (!clippedIds || clippedIds.size === 0) return messages

  const toolNames = indexToolUses(messages)
  let anyTouched = false

  const out = messages.map(msg => {
    const inner = getInner(msg)
    const content = inner.content
    if (!Array.isArray(content)) return msg

    let touched = false
    const newContent = (content as AnyContentBlock[]).map(block => {
      if (
        block?.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string' ||
        !clippedIds.has(block.tool_use_id)
      ) {
        return block
      }
      const stubbed = stubOneBlock(block, toolNames)
      if (stubbed === block) return block
      touched = true
      return stubbed
    })

    if (!touched) return msg
    anyTouched = true

    if (msg.message) {
      return { ...msg, message: { ...msg.message, content: newContent } } as T
    }
    return { ...msg, content: newContent } as T
  })

  // Identity-preserving fast path for QueryEngine (roadmap 5.7): when the
  // clipped set has ids but none of them appear in the current messages
  // (or every match is already a stub), return the input ref so callers'
  // identity guards don't reassign on every turn.
  return anyTouched ? out : messages
}

/**
 * Prune tool_result content that is older than `keepTurns` turns.
 *
 * Complements applyStableStubs: that mechanism only fires at ≥50% context
 * window (~400 turns for 200k-token models), so RSS grows unboundedly before
 * it triggers. This runs every turn, keeping only the last `keepTurns` turns'
 * tool results in full.
 *
 * "Turn boundary" = a `role: 'user'` message. Image-bearing blocks are skipped
 * to preserve vision context. Identity-preserving when nothing changes.
 */
export function pruneOldToolResults<T extends AnyMessage>(
  messages: T[],
  keepTurns = 1,
): T[] {
  if (messages.length === 0) return messages

  // Walk backwards to find the index of the (keepTurns)th-from-last user message.
  // "turn boundary" = role: 'user'. -1 means not enough turns yet.
  let cutoffIdx = -1
  let turnsFound = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role === 'user') {
      turnsFound++
      if (turnsFound >= keepTurns) {
        cutoffIdx = i
        break
      }
    }
  }

  if (cutoffIdx === -1) return messages  // fewer turns than keepTurns
  if (cutoffIdx === 0) return messages   // nothing before the cutoff to prune

  const toolNames = indexToolUses(messages)
  let anyTouched = false

  const out = messages.map((msg, idx) => {
    if (idx >= cutoffIdx) return msg

    const inner = getInner(msg)
    const content = inner.content
    if (!Array.isArray(content)) return msg

    let touched = false
    const newContent = (content as AnyContentBlock[]).map(block => {
      const stubbed = stubOneBlock(block, toolNames)
      if (stubbed === block) return block
      touched = true
      return stubbed
    })

    if (!touched) return msg
    anyTouched = true

    if (msg.message) {
      return { ...msg, message: { ...msg.message, content: newContent } } as T
    }
    return { ...msg, content: newContent } as T
  })

  return anyTouched ? out : messages
}

/**
 * Evict old fully-stubbed message pairs from the display array.
 *
 * While pruneOldToolResults replaces tool_result content with stubs,
 * the message objects remain in the array. This function goes further:
 * it removes user messages that contain ONLY stubbed tool_results,
 * along with their corresponding assistant messages if those contain
 * ONLY tool_use blocks (no text, no thinking). This frees the wrapper
 * objects and any remaining string allocation overhead.
 *
 * Safe for display-only arrays (React state). Does NOT affect
 * QueryEngine.mutableMessages (API-facing array).
 *
 * @param messages Display messages array
 * @param keepTurns Number of recent turns to preserve untouched (default 2)
 * @returns The same array reference if nothing was evicted, or a new shorter array
 */
export function evictOldStubbedMessages<T extends AnyMessage>(
  messages: T[],
  keepTurns = 2,
): T[] {
  if (messages.length === 0) return messages

  // Find cutoff: same algorithm as pruneOldToolResults but with a
  // more conservative default (keepTurns=2 vs 1) because eviction
  // is more destructive than stubbing
  let cutoffIdx = -1
  let turnsFound = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role === 'user') {
      turnsFound++
      if (turnsFound >= keepTurns) {
        cutoffIdx = i
        break
      }
    }
  }

  if (cutoffIdx === -1) return messages
  if (cutoffIdx === 0) return messages

  // Step 1: Find assistant messages before cutoff that contain ONLY tool_use
  // blocks (no text, thinking, or other content that the user needs to see).
  // Collect the tool_use_ids from these purely-tool-use assistant messages.
  const candidateToolUseIds = new Set<string>()
  const candidateAssistantIndices = new Set<number>()

  for (let i = 0; i < cutoffIdx; i++) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role !== 'assistant') continue

    const content = inner.content
    if (!Array.isArray(content)) continue

    let allToolUse = true
    for (const block of content as AnyContentBlock[]) {
      if (block?.type !== 'tool_use') {
        allToolUse = false
        break
      }
    }

    if (!allToolUse) continue
    candidateAssistantIndices.add(i)
    for (const block of content as ToolUseBlock[]) {
      if (block.id) candidateToolUseIds.add(block.id)
    }
  }

  if (candidateToolUseIds.size === 0) return messages

  // Step 2: Find user messages before cutoff whose tool_results are ALL
  // stubbed AND whose tool_use_ids are ALL in candidateToolUseIds.
  // Only evict the pair if both sides are cleanly removable.
  const evictableUserMsgIndices = new Set<number>()
  const evictedToolResultIds = new Set<string>()

  for (let i = 0; i < cutoffIdx; i++) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role !== 'user') continue

    const content = inner.content
    if (!Array.isArray(content)) continue

    let allEvictable = true
    let hasAnyBlock = false
    for (const block of content as AnyContentBlock[]) {
      hasAnyBlock = true
      if (block?.type !== 'tool_result') {
        allEvictable = false
        break
      }
      const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? ''
      if (!candidateToolUseIds.has(toolUseId)) {
        allEvictable = false
        break
      }
      // Check if the tool_result content is already a stub
      const existing = (block as { content?: unknown }).content
      if (typeof existing !== 'string' || !CLIP_STUB_PATTERN.test(existing)) {
        allEvictable = false
        break
      }
    }

    if (hasAnyBlock && allEvictable) {
      evictableUserMsgIndices.add(i)
      for (const block of content as AnyContentBlock[]) {
        const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? ''
        if (toolUseId) evictedToolResultIds.add(toolUseId)
      }
    }
  }

  if (evictableUserMsgIndices.size === 0) return messages

  // Step 3: Filter candidate assistant messages — only keep those whose
  // tool_use_ids are ALL covered by evictable user messages.
  const evictableAssistantIndices = new Set<number>()
  for (const i of candidateAssistantIndices) {
    const inner = getInner(messages[i]!)
    const content = inner.content
    if (!Array.isArray(content)) continue

    let allCovered = true
    for (const block of content as ToolUseBlock[]) {
      if (!evictedToolResultIds.has(block.id ?? '')) {
        allCovered = false
        break
      }
    }

    if (allCovered) evictableAssistantIndices.add(i)
  }

  // Build the new array without evicted messages
  const evictSet = new Set([...evictableUserMsgIndices, ...evictableAssistantIndices])
  if (evictSet.size === 0) return messages

  const out = messages.filter((_, idx) => !evictSet.has(idx))
  return out.length === messages.length ? messages : out
}

/** Maximum number of messages to keep in the display array. */
const MAX_DISPLAY_MESSAGES = 200

/**
 * Evict messages from the start of the display array when it exceeds
 * MAX_DISPLAY_MESSAGES. This prevents unbounded growth of the React
 * state array across very long sessions.
 *
 * Rules:
 * - Never evict the compact boundary message (system with subtype compact_boundary)
 * - Never evict the first system message (initial context)
 * - Always evict in complete user/assistant pairs to avoid orphaned tool_uses
 * - Preserve tool_use/tool_result pairing within evicted ranges
 *
 * The transcript on disk retains the full (cleaned) conversation for /resume.
 *
 * @param messages Display messages array
 * @param maxMessages Maximum messages to keep (default MAX_DISPLAY_MESSAGES)
 * @returns The same array reference if under limit, or a truncated array
 */
export function evictToMaxSize<T extends AnyMessage>(
  messages: T[],
  maxMessages = MAX_DISPLAY_MESSAGES,
): T[] {
  if (messages.length <= maxMessages) return messages

  // Find the compact boundary — we must keep it and everything after it
  let boundaryIdx = -1
  for (let i = 0; i < messages.length; i++) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role === 'system') {
      const subtype = (inner as { subtype?: string }).subtype
      if (subtype === 'compact_boundary') {
        boundaryIdx = i
        break
      }
    }
  }

  // Calculate how many messages to drop from the front
  const excess = messages.length - maxMessages

  // Find a safe cut point: we need to cut at a position that doesn't
  // leave orphaned tool_uses or tool_results
  let cutAt = excess

  // If there's a compact boundary, don't cut past it — cut right at it
  // (everything before the boundary is already compacted/summarized)
  if (boundaryIdx !== -1 && cutAt > boundaryIdx) {
    cutAt = boundaryIdx
  }

  // Never cut past the first message (keep at least the system/initial message)
  if (cutAt >= messages.length - 1) return messages

  // Adjust cut point to avoid splitting tool_use/tool_result pairs.
  // Walk forward from cutAt to find a safe message boundary (a message
  // that is NOT in the middle of a tool_use/tool_result pair).
  // Track the last safe cut point in case the array is all tool pairs.
  let lastSafeCut = -1
  for (let i = cutAt; i < messages.length; i++) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role

    // If we land on an assistant message that has tool_use blocks,
    // we must skip past the entire pair (assistant + tool_result)
    if (role === 'assistant') {
      const content = inner.content
      if (Array.isArray(content)) {
        const hasToolUse = (content as AnyContentBlock[]).some(
          b => b?.type === 'tool_use'
        )
        if (hasToolUse) {
          // Skip past this assistant and its tool_result response
          // (the next message should be the tool_result).
          // Set i = cutAt - 1 so the for-loop's i++ lands on cutAt,
          // avoiding a redundant re-scan of the tool_result message.
          cutAt = i + 2
          // The assistant+tool_result pair at [i, i+1] forms a complete
          // unit — cutAt = i+2 is a safe boundary between pairs.
          lastSafeCut = cutAt
          i = cutAt - 1
          continue
        }
      }
      // Assistant without tool_use — safe to cut before it
      cutAt = i
      break
    }

    // If we land on a user message that is a tool_result response,
    // we must also skip past it (its preceding assistant is already cut)
    if (role === 'user') {
      const content = inner.content
      if (Array.isArray(content)) {
        const hasToolResult = (content as AnyContentBlock[]).some(
          b => b?.type === 'tool_result'
        )
        if (hasToolResult) {
          // The pair ending at this tool_result is a complete unit.
          // After skipping past it, cutAt = i+1 is a safe boundary
          // (we're between pairs, not inside one).
          lastSafeCut = i + 1
          // Skip past this tool_result
          cutAt = i + 1
          continue
        }
      }
      // User message without tool_result — safe to cut before it
      cutAt = i
      break
    }

    // System or other message — safe to cut before it
    cutAt = i
    break
  }

  if (cutAt <= 0) return messages

  // If cutAt walked past the end (all messages from cutAt onward were
  // tool_use/tool_result pairs with no text messages to break on), fall
  // back to the last complete pair boundary we saw. This ensures we
  // still evict messages even when the tail is all tool pairs.
  if (cutAt >= messages.length) {
    if (lastSafeCut <= 0) return messages
    cutAt = lastSafeCut
  }

  const out = messages.slice(cutAt)
  return out
}

/**
 * Remove contentReplacementState entries for tool_use_ids that no longer
 * exist in the current messages array. After evictToMaxSize or
 * evictOldStubbedMessages drop messages from the display array, the
 * corresponding seenIds and replacements entries become orphans — they hold
 * references to preview strings (up to ~2KB each) that will never be looked
 * up again. This function prunes them in-place, preserving the object
 * reference held by REPL's contentReplacementStateRef.
 */
export function pruneContentReplacementState(
  messages: AnyMessage[],
  state: { seenIds: Set<string>; replacements: Map<string, unknown> },
): void {
  // Collect all tool_use_ids still present in the messages
  const liveIds = new Set<string>()
  for (const msg of messages) {
    const inner = getInner(msg)
    const role = inner.role ?? msg.role

    // Collect from assistant tool_use blocks
    if (role === 'assistant') {
      const content = inner.content
      if (Array.isArray(content)) {
        for (const block of content as ToolUseBlock[]) {
          if (block?.type === 'tool_use' && block.id) {
            liveIds.add(block.id)
          }
        }
      }
    }

    // Collect from user tool_result blocks
    if (role === 'user') {
      const content = inner.content
      if (Array.isArray(content)) {
        for (const block of content as AnyContentBlock[]) {
          if (block?.type === 'tool_result' && block.tool_use_id) {
            liveIds.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // Remove entries for IDs no longer in the message array
  for (const id of state.seenIds) {
    if (!liveIds.has(id)) state.seenIds.delete(id)
  }
  for (const id of state.replacements.keys()) {
    if (!liveIds.has(id)) state.replacements.delete(id)
  }
}
