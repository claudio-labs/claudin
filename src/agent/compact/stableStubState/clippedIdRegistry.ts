import { getSessionId, onSessionSwitch } from 'src/platform/bootstrap/state.js'
import { getAgentId } from 'src/agent/coordinator/teammate.js'
import type {
  AnyContentBlock,
  AnyMessage,
  ToolUseBlock,
} from 'src/agent/compact/stableStubState/types.js'
import { getInner } from 'src/agent/compact/stableStubState/types.js'

// Worst-case cap on the number of (session, agent) entries we hold. The
// onSessionSwitch listener drops the outgoing session's entry, so in practice
// the Map stays at 1-2 entries; this is a defensive upper bound for pathological
// resume/regenerate loops or untracked headless clients.
export const MAX_TRACKED_KEYS = 16

export const perKeyClippedIds = new Map<string, Set<string>>()

// First-write-wins registry of the exact stub bytes emitted per tool_use_id.
// The stub text embeds measures of the content present at stub time (token
// count; head bytes when stubKeepHeadChars > 0), and different views of the
// same conversation can hold different content for the same id (budget
// preview in the per-request view vs full original in a persistent array).
// Recording the first emission makes every later rewriter reproduce the
// same bytes, so the prompt-cache prefix stays stable across views.
// Lifecycle mirrors perKeyClippedIds: same key scheme, same cap, pruned and
// reset together.
const perKeyStubText = new Map<string, Map<string, string>>()

// Composite key isolates sub-agents (same sessionId, different agentId) from
// the parent. Standalone sessions key on sessionId alone.
export function currentKey(): string {
  const sid = getSessionId()
  const agentId = getAgentId()
  return agentId ? `${sid}:${agentId}` : sid
}

// Defensive LRU-ish bound shared by the single-registry per-key maps: drop
// the oldest insertion-order entry once the cap is exceeded. The listeners
// should keep this rare. The pin registries cannot use this — a key's
// shielding map and spent set must be evicted TOGETHER, see makeRoomForPinKey.
function ensureKey<V>(map: Map<string, V>, key: string, make: () => V): V {
  let value = map.get(key)
  if (!value) {
    value = make()
    if (map.size >= MAX_TRACKED_KEYS) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
  }
  return value
}

function getOrCreateForCurrent(): Set<string> {
  return ensureKey(perKeyClippedIds, currentKey(), () => new Set())
}

export function getClippedIds(): ReadonlySet<string> {
  const set = perKeyClippedIds.get(currentKey())
  return set ?? EMPTY_SET
}

export const EMPTY_SET: ReadonlySet<string> = new Set()

export function addClippedIds(ids: Iterable<string>): void {
  const set = getOrCreateForCurrent()
  for (const id of ids) {
    set.add(id)
  }
}

// Read-only lookup — never allocates a map for the key.
export function getStubTextForId(toolUseId: string): string | undefined {
  return perKeyStubText.get(currentKey())?.get(toolUseId)
}

export function recordStubText(toolUseId: string, stub: string): void {
  const map = ensureKey(perKeyStubText, currentKey(), () => new Map())
  // First-write-wins: never overwrite bytes that may already be cached
  // server-side from an earlier request.
  if (!map.has(toolUseId)) {
    map.set(toolUseId, stub)
  }
}

/** id → number of clip passes this pin has already shielded its block. */
export const perKeyPinnedIds = new Map<string, Map<string, number>>()
export const perKeySpentPinIds = new Map<string, Set<string>>()

// Read-only lookup — never allocates a map for the key.
export function getPinsForCurrent(): Map<string, number> | undefined {
  return perKeyPinnedIds.get(currentKey())
}

// --- Stand-down epoch ---------------------------------------------------
//
// Bumped when a MAIN-THREAD compaction lands. FileReadTool's stand-down
// outline state (fileStateCache's standDownOutline) records the epoch it was
// written in and stops being served once this moves: compaction rewrote the
// transcript, so the context pressure that clipped the body is gone and the
// next read of that range deserves a real body again. Without it the sticky
// state would survive a compact and answer a freshly-summarised conversation
// with an outline for a file the model can no longer see at all.
//
// Kept here, not on the cache: fileStateCache must stay a leaf module (see its
// setPinReleaseHandler doc for what importing this file from there costs), and
// postCompactCleanup already imports this one. An epoch counter also avoids
// threading readFileState through runPostCompactCleanup, which has no access
// to it and four callers.
//
// One global counter, not a per-key one. Only main-thread compacts bump it
// (postCompactCleanup owns that gate), so a sub-agent's sticky state can
// expire early — that costs one extra body, which is the conservative
// direction; the reverse (a sub-agent bumping and stranding the main thread's
// state) is the one that would matter.
let standDownEpoch = 0

export function bumpStandDownEpoch(): void {
  standDownEpoch++
}

export function getStandDownEpoch(): number {
  return standDownEpoch
}

export function resetClippedIds(): void {
  // This deletes whatever key it is currently standing in, and currentKey()
  // cannot see ordinary Agent/fork sub-agents (they run under the main key —
  // see the registry caveat above), so the CALLER must know which context is
  // asking. The one caller that couldn't — a fork's autocompact reaching here
  // via runPostCompactCleanup and deleting the PARENT's live pins — is now
  // gated there on isMainThreadCompact (querySource names the compacting
  // context, which is exactly what this registry cannot). The remaining
  // callers are single-context by construction: the REPL and slash-command
  // paths are the main thread, and swarm teammates reset their own key under
  // their own AsyncLocalStorage.
  //
  // The other obvious fix, mirroring pruneStaleClippedIds' `if (getAgentId())
  // return`, is WRONG here and was tried: that guard protects OTHER keys from
  // a teammate ("every key but mine"), whereas this function only ever
  // touches its OWN key. Adding it stops a swarm teammate from resetting the
  // set it legitimately owns, which the isolation test catches immediately.
  perKeyClippedIds.delete(currentKey())
  perKeyStubText.delete(currentKey())
  perKeyPinnedIds.delete(currentKey())
  perKeySpentPinIds.delete(currentKey())
}

/**
 * Remove perKeyClippedIds entries for keys that don't match the current
 * session/agent. After compaction, old session keys from /resume or
 * session-switch scenarios hold stale IDs whose messages no longer exist.
 * The onSessionSwitch listener handles the common case, but compaction
 * can leave orphaned sub-agent keys.
 */
export function pruneStaleClippedIds(): void {
  // "Every key but mine" only reads as "stale" from the main thread. A
  // swarm teammate compacting runs this inside runWithTeammateContext
  // (inProcessRunner), where currentKey() is `<sid>:<agentId>` — so the main
  // thread's `<sid>` key would be deleted while its messages are very much
  // alive, taking its clipped set, stub text and pins with it. That is the
  // cross-thread corruption runPostCompactCleanup's own doc warns about, and
  // for pins it re-opens the clip → re-read loop they exist to close. A
  // sub-agent has no standing to call another key stale.
  //
  // Only swarm teammates are caught here: getAgentId() is blind to ordinary
  // Agent/fork sub-agents (see the registry caveat above), and those already
  // run under the main key, so "every key but mine" is harmless for them.
  if (getAgentId()) return
  const key = currentKey()
  for (const k of perKeyClippedIds.keys()) {
    if (k !== key) perKeyClippedIds.delete(k)
  }
  for (const k of perKeyStubText.keys()) {
    if (k !== key) perKeyStubText.delete(k)
  }
  for (const k of perKeyPinnedIds.keys()) {
    if (k !== key) perKeyPinnedIds.delete(k)
  }
  for (const k of perKeySpentPinIds.keys()) {
    if (k !== key) perKeySpentPinIds.delete(k)
  }
}

/**
 * Prune clipped IDs from the current key that no longer exist in the
 * message array (e.g. after compaction removed their messages). Without
 * this, the Set for the current key grows monotonically with IDs whose
 * messages were compacted away.
 *
 * CALLER PRECONDITION: `messages` must be the transcript that OWNS the
 * current key — the main thread's. An ordinary Agent/fork sub-agent shares
 * the main key (registry caveat above) but compacts against its own view,
 * which holds none of the parent's ids: sweeping then would delete the
 * parent's LIVE pins, spent memory and clipped ids as false orphans.
 * postCompactCleanup enforces this by gating on isMainThreadCompact.
 */
export function pruneOrphanClippedIds(messages: AnyMessage[]): void {
  const ids = perKeyClippedIds.get(currentKey())
  // The stub-text registry can hold ids the clipped set doesn't (age-prune
  // stubs record bytes too), so prune it independently.
  const stubText = perKeyStubText.get(currentKey())
  // Pins are checked against the SAME key's messages only: `messages` is one
  // agent's transcript, so it is not evidence about another agent's pins.
  const pins = getPinsForCurrent()
  const spent = perKeySpentPinIds.get(currentKey())
  if (
    (!ids || ids.size === 0) &&
    (!stubText || stubText.size === 0) &&
    (!pins || pins.size === 0) &&
    (!spent || spent.size === 0)
  ) {
    return
  }

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

  if (ids) {
    for (const id of ids) {
      if (!liveIds.has(id)) ids.delete(id)
    }
  }
  if (stubText) {
    for (const id of stubText.keys()) {
      if (!liveIds.has(id)) stubText.delete(id)
    }
  }
  if (pins) {
    // A pin only means anything while its tool_result is still in the
    // transcript; compaction/eviction makes it dead weight.
    for (const id of pins.keys()) {
      if (!liveIds.has(id)) pins.delete(id)
    }
  }
  if (spent) {
    // Same rule for the memory of a spent pin — and note this is a deliberate
    // RESET, not the slot loss the spent registry exists to survive. Losing a
    // slot (FIFO, expiry, over-ceiling) keeps the block in the transcript, so
    // the model can still be looping on it and the fallback is the right
    // answer. Here the message itself is gone: there is nothing to loop on,
    // and keeping the id would make a genuinely new read of that file skip
    // straight to the outline.
    for (const id of spent) {
      if (!liveIds.has(id)) spent.delete(id)
    }
  }
}

// Test-only: reset all tracked keys. Useful for unit tests that mock
// getSessionId across a single test run.
export function _resetAllClippedIdsForTesting(): void {
  perKeyClippedIds.clear()
  perKeyStubText.clear()
  perKeyPinnedIds.clear()
  perKeySpentPinIds.clear()
  // Reset here too: the epoch gates FileReadTool's sticky outline state, so a
  // test that bumped it would otherwise leave every later test's sticky entry
  // pre-expired — a cross-file mock leak of exactly the kind testing.md warns
  // about, and one that reads as "the fallback isn't sticky" rather than as
  // stale state.
  standDownEpoch = 0
  // Sync lastSeenSessionId with the current session so that the first
  // switchSession() call in a test correctly identifies which key to evict.
  // Without this, tests that run after a mock of bootstrap/state.js has
  // changed the session ID would leave lastSeenSessionId pointing at a
  // stale key, causing subsequent switchSession() to miss the eviction.
  lastSeenSessionId = getSessionId()
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
  for (const k of perKeyStubText.keys()) {
    if (k === old || k.startsWith(`${old}:`)) {
      perKeyStubText.delete(k)
    }
  }
  for (const k of perKeyPinnedIds.keys()) {
    if (k === old || k.startsWith(`${old}:`)) {
      perKeyPinnedIds.delete(k)
    }
  }
  for (const k of perKeySpentPinIds.keys()) {
    if (k === old || k.startsWith(`${old}:`)) {
      perKeySpentPinIds.delete(k)
    }
  }
})
