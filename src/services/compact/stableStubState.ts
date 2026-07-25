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
import { getCacheProfile } from '../cache/cacheProfile.js'

/** Minimum token count for a tool_result to be immediately stubbed on display. */
const IMMEDIATE_STUB_TOKEN_THRESHOLD = 2000

// Floor below which clipping is a net loss: the stub itself ("[clipped: ~N
// tokens from <tool>]") is ~10 tokens, so anything shorter saves nothing and
// destroys potentially useful context (especially short error messages).
const MIN_STUB_TOKENS = 100

const DOCUMENT_TOKEN_FALLBACK = 2000

// Worst-case cap on the number of (session, agent) entries we hold. The
// onSessionSwitch listener drops the outgoing session's entry, so in practice
// the Map stays at 1-2 entries; this is a defensive upper bound for pathological
// resume/regenerate loops or untracked headless clients.
const MAX_TRACKED_KEYS = 16

const perKeyClippedIds = new Map<string, Set<string>>()

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

// Read-only lookup — never allocates a map for the key.
function getStubTextForId(toolUseId: string): string | undefined {
  return perKeyStubText.get(currentKey())?.get(toolUseId)
}

function recordStubText(toolUseId: string, stub: string): void {
  const key = currentKey()
  let map = perKeyStubText.get(key)
  if (!map) {
    map = new Map()
    // Same defensive LRU-ish bound as getOrCreateForCurrent.
    if (perKeyStubText.size >= MAX_TRACKED_KEYS) {
      const oldest = perKeyStubText.keys().next().value
      if (oldest !== undefined) perKeyStubText.delete(oldest)
    }
    perKeyStubText.set(key, map)
  }
  // First-write-wins: never overwrite bytes that may already be cached
  // server-side from an earlier request.
  if (!map.has(toolUseId)) {
    map.set(toolUseId, stub)
  }
}

// --- Pinned tool_results -----------------------------------------------
//
// A tool_result the model demonstrably still needs: it was clipped out of
// context, the model re-requested the exact same thing, and the re-delivered
// copy is what we pin. Every clip path funnels through stubOneBlock (age
// prune, RSS byte-guard, applyStableStubs) plus the display stub, and all of
// them skip a pinned id — so the re-send survives instead of being clipped
// again on the next pass, which is what turned "clip → re-read → clip" into
// an endless loop (see FileReadTool's clip-pin stand-down).
//
// Deliberately NOT consulted by isToolResultBlockMutable: the pin keeps a
// block from being rewritten, but never promises the clip frontier that the
// block is frozen forever. A pin can be dropped (age, FIFO, orphan prune) and
// the block clipped later — that must stay an ordinary clip event, not a
// broken immutability claim. That choice has a price, and it is why pins
// EXPIRE: because a shielded block still counts as mutable, the clip frontier
// (and the cache_control marker with it) cannot advance past it, so every
// later turn re-sends the suffix uncached. An unbounded pin therefore costs
// O(turns) under the AGGRESSIVE profile; MAX_SHIELDED_PASSES bounds it and the
// frontier resumes moving. Expiring EARLY is cheap, not dangerous: an expired
// pin is spent, so the next same-range re-read lands on the outline fallback
// rather than another re-send. The bound trades "one more protected re-send"
// for "the frontier moves again", and the fallback catches whatever it drops.
//
// TWO REGISTRIES, one state machine:
//   SHIELDING (perKeyPinnedIds) — ids the clip paths must skip. Bounded by
//     MAX_PINNED_TOOL_RESULTS slots and by MAX_SHIELDED_PASSES of age.
//   SPENT (perKeySpentPinIds) — ids that WERE pinned and no longer shield
//     anything, because they aged out, lost their slot to the FIFO, turned out
//     to be over MAX_PINNED_RESULT_TOKENS, or did their job and were retired
//     by retirePinAfterUse. They carry no obligation, only
//     the memory that this copy already got its one protected re-send.
// isPinRegistered answers over BOTH, so FileReadTool's next same-range
// re-read serves the structural-outline fallback instead of starting another
// re-send. Without the spent half, losing a slot silently re-armed the loop:
// re-send → pin → evict someone else's pin → they re-send → evict yours, one
// full body per rotation, forever.
//
// OWNERSHIP MODEL (the one place it is stated; other comments defer here):
// a pin is owned by the readFileState entry whose toolUseId it holds. The
// entry vouches that the model still needs that content, so the pin lives
// exactly as long as the entry keeps pointing at it — fileStateCache's
// dispose hook releases it the moment the entry is replaced by another range,
// overwritten by Edit/Write, deleted or LRU-evicted, and only the cache that
// took the id in through set() may release it. Everything else is a sweep for
// ids whose transcript is gone: the intact-result branch in FileReadTool,
// pruneOrphanClippedIds, pruneStaleClippedIds, onSessionSwitch.
//
// Keyed per (session, agent) exactly like perKeyClippedIds — NOT a flat set,
// because every lifecycle operation here is scoped to ONE transcript:
// pruneOrphanClippedIds receives a single agent's messages, resetClippedIds
// fires per agent out of microcompact, and onSessionSwitch only knows the
// outgoing session. The FIFO caps are per key for the same reason.
//
// CAVEAT — the isolation is real ONLY for swarm teammates. currentKey() reads
// getAgentId(), which is set by swarm/inProcessRunner's AsyncLocalStorage and
// by the --agent-id CLI args, and by nothing else. An ordinary Agent/fork
// sub-agent (tools/AgentTool/runAgent.ts, utils/forkedAgent.ts) sets neither,
// so it shares the MAIN thread's key and therefore the main thread's slots.
// Do not read the composite key as a guarantee that a sub-agent cannot touch
// the parent's pins — it can. The spent registry is what makes that survivable
// (a stolen slot degrades to the fallback instead of re-arming the loop);
// closing it properly needs a general current-agent scope, not a change here.
//
// Within a key, insertion order is the FIFO order; re-pinning refreshes it.
const MAX_PINNED_TOOL_RESULTS = 16
/** Spent ids are 8 bytes of state each — keep a longer memory than the slots. */
const MAX_SPENT_PIN_IDS = 64
/**
 * How many clip passes one pin may shield its block before it is spent.
 *
 * A "pass" is NOT a turn, and the conversion rate is not even stable. Three
 * functions tick agePinsForCurrent — applyStableStubs, pruneOldToolResults and
 * pruneToolResultsByBytes — reached from nine production call sites: every API
 * request on all three provider paths (claude/streaming.ts, openaiShim/
 * messagesClient.ts, codexShim.ts), every appended user message and compaction
 * in QueryEngine, and the REPL's own prune. So the tick rate depends on how
 * tool-dense the turn is AND on whether microcompact has fired yet (until it
 * does, applyStableStubs returns early on an empty clipped set and does not
 * tick at all):
 *
 *   quiet, pre-microcompact  ~2 ticks/turn  → 48 passes ≈ 16-24 turns
 *   busy, post-microcompact  ~13 ticks/turn → 48 passes ≈ 4 turns
 *
 * That 5x spread is why this is a safety ceiling on the clip-frontier stall and
 * NOT a promise of N turns of protection. Both ends are acceptable for what the
 * pin has to do: it only has to outlive the single turn that re-delivered the
 * body, so even the 4-turn end is comfortable, and the 24-turn end costs
 * nothing measurable (the frontier stall is structurally zero under retain,
 * where isToolResultBlockMutable short-circuits on !agePruneActive, and was
 * unmeasurable under aggressive, where nothing past the static head is cached
 * anyway). Buying a stable unit means threading a turn counter through all nine
 * call sites; the spread does not currently justify it.
 *
 * Ticked at the START of a pass, never inside pinShieldsBlock: the byte guard's
 * `remaining` accounting is only honest while its candidate filter and
 * stubOneBlock agree on what is exempt, and a counter that tipped between those
 * two calls would break exactly that.
 */
export const MAX_SHIELDED_PASSES = 48
/** id → number of clip passes this pin has already shielded its block. */
const perKeyPinnedIds = new Map<string, Map<string, number>>()
const perKeySpentPinIds = new Map<string, Set<string>>()

// Read-only lookup — never allocates a map for the key.
function getPinsForCurrent(): Map<string, number> | undefined {
  return perKeyPinnedIds.get(currentKey())
}

/**
 * Make room for a new pin key, evicting the oldest from BOTH registries.
 *
 * They must be evicted together. Dropping a key's shielding map while keeping
 * its spent set is merely conservative (everything still reads as registered),
 * but dropping the spent set while keeping the pinned map forgets a re-send
 * that already happened and hands out another one. Independent per-map bounds
 * let exactly that drift happen, since only one of the two grows on any given
 * call.
 */
function makeRoomForPinKey(key: string): void {
  if (perKeyPinnedIds.has(key) || perKeySpentPinIds.has(key)) return
  const tracked = Math.max(perKeyPinnedIds.size, perKeySpentPinIds.size)
  if (tracked < MAX_TRACKED_KEYS) return
  const oldest =
    perKeyPinnedIds.keys().next().value ??
    perKeySpentPinIds.keys().next().value
  if (oldest === undefined) return
  perKeyPinnedIds.delete(oldest)
  perKeySpentPinIds.delete(oldest)
}

/** Move an id out of its shielding slot, remembering that it was pinned. */
function retirePin(key: string, toolUseId: string): void {
  perKeyPinnedIds.get(key)?.delete(toolUseId)
  let spent = perKeySpentPinIds.get(key)
  if (!spent) {
    spent = new Set()
    makeRoomForPinKey(key)
    perKeySpentPinIds.set(key, spent)
  }
  spent.delete(toolUseId)
  spent.add(toolUseId)
  while (spent.size > MAX_SPENT_PIN_IDS) {
    const oldest = spent.values().next().value
    if (oldest === undefined) break
    spent.delete(oldest)
  }
}

export function pinToolResult(toolUseId: string): void {
  if (!toolUseId) return
  const key = currentKey()
  let pins = perKeyPinnedIds.get(key)
  if (!pins) {
    pins = new Map()
    // Same defensive LRU-ish bound as getOrCreateForCurrent.
    makeRoomForPinKey(key)
    perKeyPinnedIds.set(key, pins)
  }
  // A fresh pin is not spent: this copy is being protected right now.
  perKeySpentPinIds.get(key)?.delete(toolUseId)
  pins.delete(toolUseId)
  pins.set(toolUseId, 0)
  while (pins.size > MAX_PINNED_TOOL_RESULTS) {
    const oldest = pins.keys().next().value
    if (oldest === undefined) break
    retirePin(key, oldest)
  }
}

/**
 * Full release — the pin is gone AND forgotten, so a later clip of this id
 * starts the stand-down over from the re-send.
 *
 * ONLY for the case where the id itself stops being ours: the readFileState
 * entry that vouched for it is gone (fileStateCache's dispose hook — range
 * switch, Edit/Write, delete, LRU eviction), or the message left the transcript
 * (the orphan sweeps). A new copy of that file is genuinely a new copy and is
 * entitled to its own protected re-send.
 *
 * NOT for "the model still has the content" — that is retirePinAfterUse. Using
 * a full release there re-arms the loop: retire → the block is still intact →
 * an ordinary same-range Read forgets the id → the next clip pass stubs it →
 * full re-send → repeat, one body per rotation, forever.
 */
export function unpinToolResult(toolUseId: string): void {
  const key = currentKey()
  perKeyPinnedIds.get(key)?.delete(toolUseId)
  perKeySpentPinIds.get(key)?.delete(toolUseId)
}

/**
 * The pin did its job: this copy survived and the model demonstrably still has
 * it. Free the shielding slot (and stop stalling the clip frontier) but REMEMBER
 * that this copy already had its protected re-send, so if it is clipped later
 * the stand-down goes straight to the outline fallback instead of starting the
 * cycle again.
 *
 * No-op unless the id is currently shielding — an ordinary dedup hit on a file
 * that was never in a clip loop must not be marked spent, or its first ever
 * clip would skip the one re-send it is entitled to.
 */
export function retirePinAfterUse(toolUseId: string): void {
  if (!toolUseId) return
  const key = currentKey()
  if (!perKeyPinnedIds.get(key)?.has(toolUseId)) return
  retirePin(key, toolUseId)
}

/** One tick of the pin clock; see MAX_SHIELDED_PASSES. */
function agePinsForCurrent(): void {
  const key = currentKey()
  const pins = perKeyPinnedIds.get(key)
  if (!pins || pins.size === 0) return
  for (const [id, passes] of pins) {
    if (passes + 1 >= MAX_SHIELDED_PASSES) retirePin(key, id)
    else pins.set(id, passes + 1)
  }
}

/**
 * Was this copy ever pinned — shielding now, or spent? This is the question
 * FileReadTool's state machine asks ("did this copy already get its one
 * protected re-send?"), and it must stay true after the pin stops shielding,
 * or every expiry would re-arm the very loop the pin exists to close. Clip
 * paths must NOT use this: see pinShieldsBlock.
 */
export function isPinRegistered(toolUseId: string): boolean {
  if (!toolUseId) return false
  const key = currentKey()
  if (perKeyPinnedIds.get(key)?.has(toolUseId)) return true
  return perKeySpentPinIds.get(key)?.has(toolUseId) ?? false
}

/**
 * Is this copy shielding RIGHT NOW — i.e. is a stand-down cycle still open?
 *
 * The narrow half of isPinRegistered, for callers asking "is something in
 * flight" rather than "did this ever happen". Using the wide one for an
 * in-flight question latches forever, because spent ids are never forgotten
 * while their message lives.
 */
export function isPinShielding(toolUseId: string): boolean {
  if (!toolUseId) return false
  return perKeyPinnedIds.get(currentKey())?.has(toolUseId) ?? false
}

// Ceiling on the size of a single protected result. The count cap bounds how
// MANY blocks skip clipping, nothing bounded how many BYTES — and under the
// AGGRESSIVE profile that is the whole RSS story: retainedHighWaterTokens is
// Infinity there precisely because the age prune is the bound, so an exempt
// block is exempt from the only thing keeping old history small. Sixteen
// full-file Reads would sit untouchable until autocompact, i.e. the mechanism
// would hasten the compaction the profile exists to postpone.
//
// Above the ceiling the id is retired to the spent registry on sight: it stops
// being protected AND stops holding a shielding slot (leaving it in one burned
// a slot to protect nothing — sixteen oversized reads could evict every pin
// that was actually working). It stays registered, so the next same-range
// re-read lands on the "already had its re-send" branch and gets the
// structural outline — the better answer for a file that big anyway.
export const MAX_PINNED_RESULT_TOKENS = 8_000

/**
 * Whether a pin actually shields THIS block — registry membership AND size.
 * Every clip path must ask this one question rather than isPinRegistered: the
 * byte guard's accounting is only honest while its candidate filter and
 * stubOneBlock agree on what is exempt, and a registered-but-oversized pin is
 * deliberately not exempt.
 *
 * Retiring an oversized id here is a safe side effect precisely because it
 * cannot change the answer: false before, false after, for every later caller
 * in the same pass.
 */
export function pinShieldsBlock(toolUseId: string, content: unknown): boolean {
  if (!toolUseId) return false
  const key = currentKey()
  if (!perKeyPinnedIds.get(key)?.has(toolUseId)) return false
  if (estimateToolResultTokens(content) <= MAX_PINNED_RESULT_TOKENS) return true
  retirePin(key, toolUseId)
  return false
}

// Test-only: inspect the shielding ids for the current (session, agent).
export function _getPinnedToolResultsForTesting(): ReadonlySet<string> {
  const pins = getPinsForCurrent()
  return pins ? new Set(pins.keys()) : EMPTY_SET
}

// Test-only: inspect the spent ids for the current (session, agent).
export function _getSpentPinIdsForTesting(): ReadonlySet<string> {
  // A copy, like _getPinnedToolResultsForTesting — a live handle lets a test
  // observe later mutations and quietly assert the wrong moment in time.
  const spent = perKeySpentPinIds.get(currentKey())
  return spent ? new Set(spent) : EMPTY_SET
}

export function resetClippedIds(): void {
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
 */
export function pruneOrphanClippedIds(messages: AnyMessage[]): void {
  const ids = perKeyClippedIds.get(currentKey())
  // The stub-text registry can hold ids the clipped set doesn't (age-prune
  // and byte-guard stubs record bytes too), so prune it independently.
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
  thresholdTokens: number = IMMEDIATE_STUB_TOKEN_THRESHOLD,
  stubKeepHeadChars = 0,
): T {
  // Retain profile passes Infinity: the display array seeds the next turn's
  // API view, so stubbing here would clip content out of the model's sight
  // cross-turn. RSS is bounded by pruneToolResultsByBytes instead.
  if (!Number.isFinite(thresholdTokens)) return message
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

    // Already stubbed (pure or head-preserving form)
    if (typeof existing === 'string' && isClipStubContent(existing)) return block

    // Skip non-string content
    if (typeof existing !== 'string') return block

    // Skip if already in clippedIds (microcompact will handle it)
    if (getClippedIds().has(toolUseId)) return block

    // Pinned re-delivery — same exemption as stubOneBlock below.
    if (pinShieldsBlock(toolUseId, existing)) return block

    // Estimate tokens and check threshold
    const tokens = roughTokenCountEstimation(existing)
    if (tokens < thresholdTokens) return block

    // Look up the tool name from the preceding assistant message's tool_use block
    const toolName = findToolNameById(allMessages, toolUseId)
    anyStubbed = true
    // Same head-preserving rule as stubOneBlock: the display array seeds the
    // next turn's API view, so keeping the head here is what lets the model
    // keep referencing large outputs cross-turn without a re-read.
    const stubbedContent = headStubApplies(existing, stubKeepHeadChars)
      ? buildClipStubWithHead(toolName, tokens, existing.slice(0, stubKeepHeadChars))
      : buildClipStub(toolName, tokens)
    return {
      ...block,
      content: stubbedContent,
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

// Head-preserving variant (openclaude's mid-tier idea, single-mutation form):
// the first N chars of the original output survive above a marker line. Same
// byte-stability contract as the pure stub — built once, never recomputed.
const CLIP_STUB_HEAD_PATTERN = /\n\[clipped: ~\d+ tokens from .+ — head preserved\]$/

// Head-stubbing is only worth the mutation when it actually truncates a
// meaningful amount; below this margin the pure stub is used instead.
const HEAD_STUB_MIN_SAVINGS_CHARS = 500

// Upper bound on a plausible head-stub's total size. The head is at most a
// few thousand chars (profile stubKeepHeadChars), so any content far larger
// that merely ENDS with a marker line (e.g. the model cat-ing a transcript or
// test fixture from this repo) must NOT be classified as an already-final
// stub — that would exempt a huge result from every pruning path forever.
const HEAD_STUB_MAX_PLAUSIBLE_CHARS = 32_000

/** A tool_result content string that is already in one of the two stable
 * stub forms (pure or head-preserving). Such bytes are final: every rewriter
 * in this module returns them unchanged forever. Exported for Read's dedup
 * stand-down (clientClippingDetection.ts), which must recognize the exact
 * same forms — a drift between the two would re-point the model at clipped
 * content. */
export function isClipStubContent(content: string): boolean {
  return (
    CLIP_STUB_PATTERN.test(content) ||
    (content.length <= HEAD_STUB_MAX_PLAUSIBLE_CHARS &&
      CLIP_STUB_HEAD_PATTERN.test(content))
  )
}

/** Whether `content` takes the head-preserving stub form for the given
 * headChars. Single source of truth — stubOneBlock, the display stub and
 * the byte-guard's savings accounting must agree byte-for-byte, or the
 * same content could render different stub forms across paths (a wire
 * byte flip that breaks the prompt-cache prefix). */
function headStubApplies(content: unknown, headChars: number): content is string {
  return (
    headChars > 0 &&
    typeof content === 'string' &&
    content.length > headChars + HEAD_STUB_MIN_SAVINGS_CHARS
  )
}

/** Deterministic head-preserving stub: first `headChars` of the original
 * content + a marker line. CRITICAL: byte-stable for the same inputs — no
 * timestamps, no recomputation (guarded by CLIP_STUB_HEAD_PATTERN). */
export function buildClipStubWithHead(
  toolName: string,
  originalTokens: number,
  head: string,
): string {
  return `${head}\n[clipped: ~${Math.max(0, Math.round(originalTokens))} tokens from ${toolName} — head preserved]`
}

function arrayContainsImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const item of content as Array<{ type?: string }>) {
    if (item && typeof item === 'object' && item.type === 'image') return true
  }
  return false
}

// Mirrors stripExcessMediaItems' isMedia: it strips image AND document
// blocks, nested in tool_results or top-level in user messages — the
// frontier's media-churn rule must cover the same set.
function isMediaBlockType(type: string | undefined): boolean {
  return type === 'image' || type === 'document'
}

function arrayContainsMedia(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const item of content as Array<{ type?: string }>) {
    if (item && typeof item === 'object' && isMediaBlockType(item.type)) return true
  }
  return false
}

/**
 * Decide whether an age-based prune pass should clip this block.
 * Distinct from the explicit clip path (applyStableStubs), which honors
 * QueryEngine's decision to clip regardless of size or error flag.
 *
 * Skip cases:
 *   - is_error: short error bodies (e.g. interrupted Agent) carry the only
 *     user-visible context for the failure; clipping destroys them.
 *   - content under MIN_STUB_TOKENS: the stub itself (~10 tokens) saves
 *     nothing here and just replaces real text with "[clipped: ~N tokens…]".
 */
function shouldAgeStub(block: AnyContentBlock): boolean {
  if (block?.type !== 'tool_result') return true
  const tr = block as ToolResultBlockParam
  if (tr.is_error) return false
  const existing = tr.content
  if (existing == null || existing === '') return true
  if (typeof existing === 'string' && isClipStubContent(existing)) return true
  return estimateToolResultTokens(existing) >= MIN_STUB_TOKENS
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
  stubKeepHeadChars = 0,
): AnyContentBlock {
  if (block?.type !== 'tool_result') return block
  const existing = (block as ToolResultBlockParam).content
  if (typeof existing === 'string' && isClipStubContent(existing)) return block
  if (existing == null || existing === '') return block
  if (Array.isArray(existing) && existing.length === 0) return block
  if (arrayContainsImage(existing)) return block
  const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? ''
  // Pinned: the model already lost this content once and asked for it back.
  // Clipping it again is exactly what the pin exists to prevent — every clip
  // path (age prune, byte guard, explicit clip) lands here, so this single
  // check covers all of them.
  if (pinShieldsBlock(toolUseId, existing)) return block
  // First-write-wins replay: if this id was already stubbed in this session
  // (by any rewriter, over any content view), reproduce those exact bytes.
  // Different views can hold different content for the same id (budget
  // preview vs full original) — recomputing would embed a different token
  // count / head and flip the wire bytes, breaking the cached prefix.
  if (toolUseId) {
    const recorded = getStubTextForId(toolUseId)
    if (recorded !== undefined) {
      return { ...block, content: recorded }
    }
  }
  const toolName = toolNames.get(toolUseId) ?? 'tool'
  const tokens = estimateToolResultTokens(existing)
  // Head-preserving form: one mutation, same break cost as the pure stub,
  // but the model keeps the useful head of the output (file headers, top
  // grep hits) — fewer re-reads. Only when it meaningfully truncates.
  const stub = headStubApplies(existing, stubKeepHeadChars)
    ? buildClipStubWithHead(
        toolName,
        tokens,
        existing.slice(0, stubKeepHeadChars),
      )
    : buildClipStub(toolName, tokens)
  if (toolUseId) {
    recordStubText(toolUseId, stub)
  }
  return {
    ...block,
    content: stub,
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

  // One tick of the pin clock per real clip pass (see MAX_SHIELDED_PASSES).
  // Taken here, before any block is examined, so every pinShieldsBlock call
  // in this pass gets the same answer.
  agePinsForCurrent()
  const toolNames = indexToolUses(messages)
  let anyTouched = false
  // Same head-preserving form as the age prune / byte guard: the explicit
  // clip path MUST produce identical bytes for a given content, or a block
  // can render as a pure stub on the wire (this per-request path) and as a
  // head-stub in engine state (prune) on the next request — a wire byte
  // flip that breaks the prompt-cache prefix once per affected block.
  const stubKeepHeadChars = getCacheProfile().stubKeepHeadChars

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
      const stubbed = stubOneBlock(block, toolNames, stubKeepHeadChars)
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
 * Clip-frontier feature flag (CLAUDIN_CLIP_FRONTIER, default ON).
 *
 * The Anthropic renderer caps the message-level cache_control marker at the
 * clip frontier (see getClipFrontierIndex) instead of letting the defer-walk
 * place it anywhere near the tail. Validated by the Phase 4 A/B benches
 * (write −90%, cost −23..−51% vs the per-turn-break baseline; eviction
 * behavior measured equal to Claude Code's). Set CLAUDIN_CLIP_FRONTIER=0
 * to revert to the defer-only placement.
 */
function readClipFrontierEnabled(): boolean {
  const raw = process.env.CLAUDIN_CLIP_FRONTIER?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}
// Memoized at module load; tests that flip the env must call
// _resetClipFrontierForTesting() (matches the defer-cache-marker pattern).
let clipFrontierEnabled = readClipFrontierEnabled()
export function isClipFrontierEnabled(): boolean {
  return clipFrontierEnabled
}
export function _resetClipFrontierForTesting(): void {
  clipFrontierEnabled = readClipFrontierEnabled()
}

/**
 * Which cross-turn history rewriters are active, so the frontier can treat
 * their not-yet-rewritten targets as mutable. Callers pass the corresponding
 * config flags (thinkingHistoryRedactionEnabled / narrationHistoryRedactionEnabled).
 */
export type ClipFrontierMutability = {
  /** stripOldThinkingBlocks is active: assistant messages still carrying a
   * `thinking` block will be rewritten once they age out of its keep window. */
  thinkingIsMutable?: boolean
  /** stripOldNarrationBlocks is active: assistant turns mixing text with a
   * tool_use (and no thinking) will lose their text blocks when they age out. */
  narrationIsMutable?: boolean
  /** Whether the age prune (pruneOldToolResults with finite keepTurns) is
   * running. Under the 'retain' cache profile it is not — full tool_results
   * are then byte-stable (only the rare RSS guard touches them, which is a
   * deliberate break-once clip event) and may be frozen behind the marker.
   * Default true (aggressive profile). */
  agePruneActive?: boolean
  /** The request exceeds the API media cap, so stripExcessMediaItems is
   * dropping the OLDEST media items — which churns image-bearing
   * tool_results deep in the prefix as new media arrives. When set, such
   * blocks are mutable and the frontier must stop before the first one. */
  imagesAreMutable?: boolean
}

/**
 * Decide whether a tool_result block can still change bytes on a future turn.
 *
 * Mirrors the two rewriters that touch tool_results at the API boundary:
 *   - pruneOldToolResults (age prune): stubs non-error, non-image results
 *     at or above MIN_STUB_TOKENS once they cross the keepTurns cutoff.
 *   - applyStableStubs (explicit clip): rewrites any id in clippedIds as soon
 *     as content allows — including the deferred-image case where the stub is
 *     delayed until the image content is replaced.
 *
 * Must stay in sync with shouldAgeStub/stubOneBlock above; the regression
 * tests in stableStubState.test.ts pin the correspondence.
 *
 * ONE deliberate exception: the pin registry. A pinned block will not be
 * rewritten *right now*, but the pin can be dropped later (age, FIFO, orphan
 * prune, the model moving on) and the block clipped then. Reporting it
 * immutable would advertise a freeze we cannot honor — a cache-prefix break
 * instead of an ordinary clip event. So pins are NOT consulted here, on
 * purpose; the "clip frontier ignores pins" test guards the decision.
 *
 * Cost of that choice: under the AGGRESSIVE profile a pinned full result keeps
 * counting as mutable, so the frontier (and with it the cache_control marker)
 * stalls just before it while the pin lasts, and every later turn re-sends the
 * suffix uncached. That is why pins EXPIRE (MAX_SHIELDED_PASSES): the stall is
 * bounded to the passes the pin is actually needed for, instead of growing at
 * O(turns) until autocompact. Do NOT read the profile's readMult 1.0 as "this
 * profile has no cache to lose" — cacheProfile.ts says outright that writeMult
 * and readMult are rationale fields no arithmetic consumes. Breakpoints are
 * still emitted, so the stall costs real money. Under RETAIN the question does
 * not arise: a full tool_result is immutable there anyway (see the
 * agePruneActive branch below).
 */
function isToolResultBlockMutable(
  block: AnyContentBlock,
  clippedIds: ReadonlySet<string>,
  agePruneActive: boolean,
  imagesAreMutable: boolean,
): boolean {
  if (block?.type !== 'tool_result') return false
  const existing = (block as unknown as ToolResultBlockParam).content
  // Already a byte-stable stub (pure or head form) — final bytes forever.
  if (typeof existing === 'string' && isClipStubContent(existing)) return false
  // Empty content is never rewritten.
  if (existing == null || existing === '') return false
  if (Array.isArray(existing) && existing.length === 0) return false
  // Pending explicit clip (checked before the image/error skips: clippedIds
  // membership overrides both in applyStableStubs' stubOneBlock path).
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
  if (toolUseId && clippedIds.has(toolUseId)) return true
  // Past the media cap, stripExcessMediaItems rewrites the oldest
  // media-bearing blocks (image OR document) turn by turn — not stable then.
  if (imagesAreMutable && arrayContainsMedia(existing)) return true
  // Retain profile: no age prune → a full tool_result is byte-stable. The
  // RSS guard may still stub it someday, but that's a deliberate
  // break-once clip event, not a per-turn mutation to fence off.
  if (!agePruneActive) return false
  // The age prune skips image-bearing and error results entirely…
  if (arrayContainsImage(existing)) return false
  if ((block as unknown as ToolResultBlockParam).is_error) return false
  // …and only stubs results at or above the floor.
  return estimateToolResultTokens(existing) >= MIN_STUB_TOKENS
}

function isAssistantContentMutable(
  content: AnyContentBlock[],
  opts: ClipFrontierMutability,
): boolean {
  if (!opts.thinkingIsMutable && !opts.narrationIsMutable) return false
  let hasText = false
  let hasToolUse = false
  let hasThinking = false
  let hasRedactedThinking = false
  for (const block of content) {
    if (block?.type === 'text') hasText = true
    else if (block?.type === 'tool_use') hasToolUse = true
    else if (block?.type === 'thinking') hasThinking = true
    else if (block?.type === 'redacted_thinking') hasRedactedThinking = true
  }
  if (opts.thinkingIsMutable && hasThinking) return true
  // Narration selection mirrors stripOldNarrationBlocks: text + tool_use and
  // no (redacted_)thinking — thinking-bearing turns are never text-stripped
  // (doing so breaks the signed-thinking position chain).
  if (
    opts.narrationIsMutable &&
    hasText &&
    hasToolUse &&
    !hasThinking &&
    !hasRedactedThinking
  ) {
    return true
  }
  return false
}

/**
 * Clip frontier: the largest index F such that messages[0..F] are all
 * byte-stable across future turns — no block in the prefix will ever be
 * rewritten by the age prune, the explicit clip set, or the history
 * redactions. Returns messages.length - 1 when nothing is mutable, and -1
 * when the very first message already contains a mutable block.
 *
 * Placing the message-level cache_control marker at (or before) the frontier
 * guarantees that clipping and prefix-freezing are the same atomic event:
 * bytes only ever change in the uncached tail, so the recurring per-turn
 * prefix invalidation (full→stub mutation behind the marker) cannot happen.
 *
 * Must be computed on the exact array handed to addCacheBreakpoints —
 * post ensureToolResultPairing, post applyStableStubs, post history
 * redactions — so the stability judgment matches the wire bytes.
 */
export function getClipFrontierIndex(
  messages: readonly AnyMessage[],
  opts: ClipFrontierMutability = {},
): number {
  const clippedIds = getClippedIds()
  const agePruneActive = opts.agePruneActive ?? true
  const imagesAreMutable = opts.imagesAreMutable ?? false
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const inner = getInner(msg)
    const role = inner.role ?? msg.role
    const content = inner.content
    if (!Array.isArray(content)) continue
    if (role === 'assistant') {
      if (isAssistantContentMutable(content as AnyContentBlock[], opts)) {
        return i - 1
      }
      continue
    }
    if (role !== 'user') continue
    for (const block of content as AnyContentBlock[]) {
      // Top-level media blocks (pasted screenshots, PDF attachments) are
      // also stripped by stripExcessMediaItems past the cap.
      if (imagesAreMutable && isMediaBlockType(block?.type)) return i - 1
      if (
        isToolResultBlockMutable(
          block,
          clippedIds,
          agePruneActive,
          imagesAreMutable,
        )
      ) {
        return i - 1
      }
    }
  }
  return messages.length - 1
}

/**
 * Walk backwards to find the index of the (keepTurns)th-from-last user
 * message. "Turn boundary" = role: 'user'. Returns -1 when fewer turns
 * exist. Shared by the age prune, the byte guard and the display eviction
 * so all three protect the same window.
 */
function findTurnCutoffIndex(
  messages: readonly AnyMessage[],
  keepTurns: number,
): number {
  let turnsFound = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role === 'user') {
      turnsFound++
      if (turnsFound >= keepTurns) return i
    }
  }
  return -1
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
  stubKeepHeadChars = 0,
): T[] {
  if (messages.length === 0) return messages
  // Retain profile passes Infinity (age clipping disabled): skip the
  // guaranteed-no-op O(n) walk on the per-append hot path.
  if (!Number.isFinite(keepTurns)) return messages

  const cutoffIdx = findTurnCutoffIndex(messages, keepTurns)
  if (cutoffIdx === -1) return messages  // fewer turns than keepTurns
  if (cutoffIdx === 0) return messages   // nothing before the cutoff to prune

  // One tick of the pin clock per real clip pass (see MAX_SHIELDED_PASSES).
  // Taken before any block is examined so the shielding answer is constant
  // for this whole pass.
  agePinsForCurrent()
  const toolNames = indexToolUses(messages)
  let anyTouched = false

  const out = messages.map((msg, idx) => {
    if (idx >= cutoffIdx) return msg

    const inner = getInner(msg)
    const content = inner.content
    if (!Array.isArray(content)) return msg

    let touched = false
    const newContent = (content as AnyContentBlock[]).map(block => {
      if (!shouldAgeStub(block)) return block
      const stubbed = stubOneBlock(block, toolNames, stubKeepHeadChars)
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
 * RSS-pressure prune (cache-profile 'retain', design doc Phase 5).
 *
 * Under the retain profile the age prune is disabled — full tool_results
 * stay in context so the provider cache serves them at the read multiplier
 * instead of re-billing clipped content at full price. This guard is what
 * bounds memory instead: when the estimated total tokens of full (stubable)
 * tool_results exceed `highWaterTokens`, stub OLDEST-FIRST until the total
 * drops to `lowWaterTokens`. The last `keepRecentTurns` user turns are never
 * touched (same cutoff walk as pruneOldToolResults).
 *
 * Each firing is one deliberate clip event: bytes mutate inside the frozen
 * prefix, the cache breaks ONCE, then the stable stubs hold (the original
 * stable-stub contract). Identity-preserving when under the high water or
 * when nothing before the cutoff is stubable.
 */
export function pruneToolResultsByBytes<T extends AnyMessage>(
  messages: T[],
  highWaterTokens: number,
  lowWaterTokens: number,
  keepRecentTurns = 2,
  stubKeepHeadChars = 0,
): T[] {
  if (!Number.isFinite(highWaterTokens) || messages.length === 0) return messages

  // Cutoff first: only CLEARABLE pressure (pre-cutoff candidates) counts
  // toward the trigger. Tokens living inside the protected keepRecentTurns
  // window cannot be reclaimed here, so counting them would let a couple of
  // huge recent results trip the guard and mass-stub the ENTIRE older
  // prefix without ever reaching the low-water target — wiping the retained
  // context the guard exists to protect, for negligible relief.
  const cutoffIdx = findTurnCutoffIndex(messages, keepRecentTurns)
  if (cutoffIdx <= 0) return messages

  // One tick of the pin clock per real clip pass (see MAX_SHIELDED_PASSES),
  // taken before the candidate walk so pinShieldsBlock gives the same answer
  // to the filter below and to stubOneBlock later in this pass.
  //
  // This tick is what makes expiry work AT ALL under the retain profile: retain
  // sets keepTurns to Infinity, so pruneOldToolResults returns before its tick,
  // and applyStableStubs returns early while the clipped set is empty. Without
  // this line a pin placed under retain never aged — and retain is the one
  // profile where the byte guard the expiry protects actually runs, so up to
  // MAX_PINNED_TOOL_RESULTS × MAX_PINNED_RESULT_TOKENS would sit permanently
  // exempt from the RSS bound (and, because pinned blocks `continue` before
  // `clearableTokens += tokens` below, invisible to the high-water trigger too).
  agePinsForCurrent()

  // Pass 1: clearable pressure across pre-cutoff full stubable tool_results.
  // `savings` is what stubbing actually frees: head-stubs retain
  // ~stubKeepHeadChars worth of tokens, but only for string content long
  // enough to take the head form — array content and shorter strings get
  // the pure stub (full savings). Mirrors stubOneBlock's branch exactly.
  type Candidate = { msgIdx: number; blockIdx: number; savings: number }
  const headTokensEstimate =
    stubKeepHeadChars > 0 ? Math.ceil(stubKeepHeadChars / 4) : 0
  const candidates: Candidate[] = []
  let clearableTokens = 0
  for (let i = 0; i < cutoffIdx; i++) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role !== 'user') continue
    const content = inner.content
    if (!Array.isArray(content)) continue
    for (let j = 0; j < content.length; j++) {
      const block = (content as AnyContentBlock[])[j]!
      if (block?.type !== 'tool_result') continue
      const existing = (block as unknown as ToolResultBlockParam).content
      if (typeof existing === 'string' && isClipStubContent(existing)) continue
      if (existing == null || existing === '') continue
      if (Array.isArray(existing) && existing.length === 0) continue
      if (arrayContainsImage(existing)) continue
      if ((block as unknown as ToolResultBlockParam).is_error) continue
      // Pinned blocks are exempt in stubOneBlock, so counting them here would
      // corrupt the accounting: `remaining` would drop for bytes we never
      // actually free, and the guard would stop short of the low water while
      // believing it got there. Skip them as candidates outright.
      //
      // Reachable under RETAIN only: AGGRESSIVE sets retainedHighWaterTokens
      // to Infinity, so this whole function returns before here. The guard
      // still belongs here — the profile is user-switchable at runtime.
      const blockToolUseId = (block as { tool_use_id?: string }).tool_use_id
      if (pinShieldsBlock(blockToolUseId ?? '', existing)) continue
      const tokens = estimateToolResultTokens(existing)
      if (tokens < MIN_STUB_TOKENS) continue
      const savings = headStubApplies(existing, stubKeepHeadChars)
        ? Math.max(0, tokens - headTokensEstimate)
        : tokens
      clearableTokens += tokens
      candidates.push({ msgIdx: i, blockIdx: j, savings })
    }
  }
  if (clearableTokens <= highWaterTokens) return messages

  // Pass 2: stub oldest-first (candidates are already in array order) until
  // the remaining clearable total reaches the low water.
  const toStub = new Map<number, Set<number>>()
  let remaining = clearableTokens
  for (const c of candidates) {
    if (remaining <= lowWaterTokens) break
    let set = toStub.get(c.msgIdx)
    if (!set) {
      set = new Set()
      toStub.set(c.msgIdx, set)
    }
    set.add(c.blockIdx)
    remaining -= c.savings
  }
  if (toStub.size === 0) return messages

  const toolNames = indexToolUses(messages)
  const out = messages.map((msg, idx) => {
    const blockIdxs = toStub.get(idx)
    if (!blockIdxs) return msg
    const inner = getInner(msg)
    const content = inner.content as AnyContentBlock[]
    const newContent = content.map((block, j) =>
      blockIdxs.has(j) ? stubOneBlock(block, toolNames, stubKeepHeadChars) : block,
    )
    if (msg.message) {
      return { ...msg, message: { ...msg.message, content: newContent } } as T
    }
    return { ...msg, content: newContent } as T
  })
  return out
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
 * NOT free for the prompt cache: in the REPL the display array seeds the
 * next turn's API view (messagesRef.current → handlePromptSubmit), so every
 * eviction removes messages from behind the cache marker — a prefix
 * mutation that invalidates the cached prefix from the first removed pair.
 * The REPL therefore amortizes the cost: it passes minEvictable
 * (EVICT_MIN_BATCH) so eviction fires once per accumulated batch instead
 * of once per turn, and notifies the cache-break detector when it does.
 * The idle-gap sweep passes minEvictable=1 — destruction is free when the
 * server-side cache has already expired.
 *
 * @param messages Display messages array
 * @param keepTurns Number of recent turns to preserve untouched (default 2)
 * @param minEvictable Minimum number of evictable messages required before
 *   anything is removed (default 1 = evict whenever possible)
 * @returns The same array reference if nothing was evicted, or a new shorter array
 */
export function evictOldStubbedMessages<T extends AnyMessage>(
  messages: T[],
  keepTurns = 2,
  minEvictable = 1,
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
      // PURE stubs only, deliberately: head-preserving stubs carry content
      // the model still uses (file headers, top grep hits), and this array
      // seeds the next turn's API view in the REPL — evicting head-stub
      // pairs would both destroy that retained context and REMOVE messages
      // from the wire history (a prefix mutation the clip frontier cannot
      // anticipate, breaking the cache every eviction). Display growth from
      // retained head-stub pairs is bounded by evictToMaxSize.
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

  // Amortization gate: each eviction event costs one prompt-cache prefix
  // invalidation (see docstring), so don't pay it for a handful of pairs —
  // wait until a batch has accumulated and remove them all in one break.
  if (evictSet.size < minEvictable) return messages

  const out = messages.filter((_, idx) => !evictSet.has(idx))
  return out.length === messages.length ? messages : out
}

/** Maximum number of messages to keep in the display array. */
export const MAX_DISPLAY_MESSAGES = 200

/**
 * Hysteresis trigger for evictToMaxSize in the REPL: don't cut until the
 * array exceeds this, then cut back to MAX_DISPLAY_MESSAGES. Each cut is a
 * deliberate prompt-cache prefix invalidation (the display array seeds the
 * next request), so the band amortizes it to roughly one break per
 * (EVICT_TRIGGER_AT - MAX_DISPLAY_MESSAGES) messages instead of one per
 * turn once the session crosses the cap. The wider steady-state display
 * (up to 300 messages of mostly-stubbed content) is an accepted trade.
 */
export const EVICT_TRIGGER_AT = 300

/**
 * Batch floor for evictOldStubbedMessages in the REPL: accumulate at least
 * this many evictable messages (12 stub-only pairs) before paying the
 * eviction's cache break. Pure-stub pairs are ~100 bytes each, so holding
 * a partial batch costs almost nothing.
 */
export const EVICT_MIN_BATCH = 24

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
 * Like evictOldStubbedMessages, this is NOT free for the prompt cache in
 * the REPL (the display array seeds the next request) — cutting from the
 * front invalidates the whole cached prefix. Callers amortize via the
 * triggerAt hysteresis band: nothing happens until length > triggerAt,
 * then the array is cut back to maxMessages in one break.
 *
 * @param messages Display messages array
 * @param maxMessages Maximum messages to keep (default MAX_DISPLAY_MESSAGES)
 * @param triggerAt Length above which the cut fires (default maxMessages —
 *   i.e. no hysteresis; the REPL passes EVICT_TRIGGER_AT)
 * @returns The same array reference if under limit, or a truncated array
 */
export function evictToMaxSize<T extends AnyMessage>(
  messages: T[],
  maxMessages = MAX_DISPLAY_MESSAGES,
  triggerAt = maxMessages,
): T[] {
  if (messages.length <= Math.max(triggerAt, maxMessages)) return messages

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
