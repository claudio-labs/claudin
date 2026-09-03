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
import { getSessionId, onSessionSwitch } from 'src/platform/bootstrap/state.js'
import { getAgentId } from 'src/agent/coordinator/teammate.js'
import { setPinReleaseHandler } from 'src/shared/fs/fileStateCache.js'
import { estimateImageTokens } from 'src/agent/context/imageTokenEstimator.js'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import type { ReliefCandidate } from 'src/agent/compact/reliefPolicy.js'

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
  const map = ensureKey(perKeyStubText, currentKey(), () => new Map())
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
  // Every declared member is optional, which would make this a "weak type":
  // TypeScript then rejects any argument that shares none of these three keys,
  // so `Message` (a union whose `AttachmentMessage` arm has none of them) is
  // not assignable and `applyStableStubs(messages)` fails to infer `T`. The
  // index signature is what makes the structural check pass — the same shape
  // `AnyContentBlock` above already uses.
  [k: string]: unknown
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
  // cross-turn. RSS is bounded by the relief policy's rss lane instead.
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
 * the relief candidate walk's savings accounting must agree byte-for-byte, or the
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
  // path (age prune, explicit clip) lands here, so this single
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
  // Same head-preserving form as the age prune: the explicit
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
 * exist. Shared by the age prune and the relief candidate walk so both
 * protect the same window.
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
 * The clearable-candidate walk shared by the relief policy's two lanes
 * (`reliefPolicy.ts`). Returns every full, stubable tool_result older than
 * the protected `keepRecentTurns` window, OLDEST FIRST, with what stubbing
 * each one frees, plus their total — the "retained full result tokens" the
 * rss lane triggers on.
 *
 * Only CLEARABLE pressure is counted: tokens inside the protected window
 * cannot be reclaimed here, so counting them would let a couple of huge
 * recent results trip the rss lane and mass-clip the ENTIRE older prefix
 * without ever reaching its target — wiping the retained context the lane
 * exists to protect, for negligible relief.
 *
 * Skipped (and not counted): stubs, empty/error/image-bearing results,
 * blocks under `MIN_STUB_TOKENS`, pinned blocks (stubOneBlock would leave
 * them intact, so counting them corrupts the accounting), ids already in the
 * clipped set (pre-request the array still holds their full content — the
 * wire rewrites them; counting them would re-fire the lane on the very next
 * request), and tools the caller's `isClearableTool` rejects.
 *
 * `savings` mirrors stubOneBlock's branch exactly: head-stubs retain
 * ~stubKeepHeadChars worth of tokens, but only for string content long
 * enough to take the head form — array content and shorter strings get the
 * pure stub (full savings).
 */
export function collectClearableCandidates(
  messages: readonly AnyMessage[],
  keepRecentTurns: number,
  stubKeepHeadChars: number,
  isClearableTool: (toolName: string) => boolean = () => true,
): { candidates: ReliefCandidate[]; clearableTokens: number } {
  const none = { candidates: [], clearableTokens: 0 }
  if (messages.length === 0) return none
  const cutoffIdx = findTurnCutoffIndex(messages, keepRecentTurns)
  if (cutoffIdx <= 0) return none

  // One tick of the pin clock per real clip pass (see MAX_SHIELDED_PASSES),
  // taken before the candidate walk so pinShieldsBlock gives the same answer
  // here and to stubOneBlock when the clip is applied.
  //
  // This tick is what makes expiry work AT ALL under the retain profile: retain
  // sets keepTurns to Infinity, so pruneOldToolResults returns before its tick,
  // and applyStableStubs returns early while the clipped set is empty. Without
  // this line a pin placed under retain never aged — and retain is the one
  // profile where the rss lane the expiry protects actually runs, so up to
  // MAX_PINNED_TOOL_RESULTS × MAX_PINNED_RESULT_TOKENS would sit permanently
  // exempt from the RSS bound (and, because pinned blocks `continue` before
  // `clearableTokens += tokens` below, invisible to the trigger too).
  agePinsForCurrent()

  const clipped = getClippedIds()
  const toolNames = indexToolUses(messages)
  const headTokensEstimate =
    stubKeepHeadChars > 0 ? Math.ceil(stubKeepHeadChars / 4) : 0
  const candidates: ReliefCandidate[] = []
  let clearableTokens = 0
  for (let i = 0; i < cutoffIdx; i++) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role !== 'user') continue
    const content = inner.content
    if (!Array.isArray(content)) continue
    for (const block of content as AnyContentBlock[]) {
      if (block?.type !== 'tool_result') continue
      const existing = (block as unknown as ToolResultBlockParam).content
      if (typeof existing === 'string' && isClipStubContent(existing)) continue
      if (existing == null || existing === '') continue
      if (Array.isArray(existing) && existing.length === 0) continue
      if (arrayContainsImage(existing)) continue
      if ((block as unknown as ToolResultBlockParam).is_error) continue
      const toolUseId = (block as { tool_use_id?: string }).tool_use_id
      if (!toolUseId || clipped.has(toolUseId)) continue
      if (!isClearableTool(toolNames.get(toolUseId) ?? '')) continue
      if (pinShieldsBlock(toolUseId, existing)) continue
      const tokens = estimateToolResultTokens(existing)
      if (tokens < MIN_STUB_TOKENS) continue
      const savings = headStubApplies(existing, stubKeepHeadChars)
        ? Math.max(0, tokens - headTokensEstimate)
        : tokens
      clearableTokens += tokens
      candidates.push({ toolUseId, savings })
    }
  }
  return { candidates, clearableTokens }
}

/**
 * Remove contentReplacementState entries for tool_use_ids that no longer
 * exist in the current messages array. After /compact, a rewind or a resume
 * drop messages from the display array, the corresponding seenIds and
 * replacements entries become orphans — they hold references to preview
 * strings (up to ~2KB each) that will never be looked up again. This
 * function prunes them in-place, preserving the object reference held by
 * REPL's contentReplacementStateRef.
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
