import { setPinReleaseHandler } from 'src/shared/fs/fileStateCache.js'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import { estimateToolResultTokens } from 'src/agent/compact/stableStubState/types.js'
import {
  EMPTY_SET,
  MAX_TRACKED_KEYS,
  currentKey,
  getPinsForCurrent,
  perKeyPinnedIds,
  perKeySpentPinIds,
} from 'src/agent/compact/stableStubState/clippedIdRegistry.js'

// --- Pinned tool_results -----------------------------------------------
//
// A tool_result the model demonstrably still needs: it was clipped out of
// context, the model re-requested the exact same thing, and the re-delivered
// copy is what we pin. Every clip path funnels through stubOneBlock (age
// prune, applyStableStubs) plus the display stub, and the relief candidate
// walk (collectClearableCandidates) skips pinned ids too — so all of
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
// The one sweep that was NOT survivable — pruneOrphanClippedIds reading a
// fork's post-compact transcript as authority for the shared key and deleting
// the parent's LIVE pins as orphans — is closed at the caller instead:
// postCompactCleanup only runs it for main-thread compacts (querySource),
// which is exactly the context this registry cannot name.
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
 * collectClearableCandidates — reached from nine production call sites: every API
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
 * Ticked at the START of a pass, never inside pinShieldsBlock: the relief
 * policy's savings accounting is only honest while its candidate walk and
 * stubOneBlock agree on what is exempt, and a counter that tipped between those
 * two calls would break exactly that.
 */
export const MAX_SHIELDED_PASSES = 48

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

// fileStateCache owns the "an entry stopped vouching for this tool_use" event
// but must stay a leaf module (see setPinReleaseHandler's doc for why), so the
// dependency is inverted: it calls in here rather than importing this file.
// Registered at module scope because every path that can place a pin has
// already imported this module by then — placing one requires pinToolResult.
setPinReleaseHandler(unpinToolResult)

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
export function agePinsForCurrent(): void {
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
 * relief policy's accounting is only honest while its candidate walk and
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

/**
 * Would a re-sent body of this text be over the ceiling, i.e. would the pin be
 * retired on sight by pinShieldsBlock without ever shielding anything?
 *
 * Asked BEFORE the re-send rather than after. Pinning first and discovering
 * the size later cost a full futile body every cycle: the copy was clipped in
 * the same pass that first examined it, and the id then sat in the spent
 * registry making the NEXT read take the fallback anyway. The answer was
 * always going to be the fallback — this just stops paying a body to reach it.
 *
 * Lives here so one place owns the ceiling. The caller measures the bytes it
 * is about to re-send, which is close enough: the rendered result adds line
 * prefixes, so this under-estimates slightly, in the safe direction (a body
 * near the boundary still gets its protected re-send).
 */
export function exceedsPinnedResultCeiling(text: string): boolean {
  return roughTokenCountEstimation(text) > MAX_PINNED_RESULT_TOKENS
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
