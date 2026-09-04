import { LRUCache } from 'lru-cache'
import { normalize } from 'path'

/**
 * One earlier Read of the same file version: the lines the model actually saw,
 * and the 1-based line the slice starts at.
 */
export type SeenRange = { offset: number; content: string }

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  // True when this entry was populated by auto-injection (e.g. CLAUDE.md) and
  // the injected content did not match disk (stripped HTML comments, stripped
  // frontmatter, truncated MEMORY.md). The model has only seen a partial view;
  // Write must require an explicit Read first, and so must Edit/apply_patch
  // unless `injectedView` below says what the model saw. `content` here holds
  // the RAW disk bytes (for getChangedFiles diffing), not what the model saw.
  isPartialView?: boolean
  // What the model DID see, for the auto-injected case above: the stripped or
  // truncated text that went into the system reminder. With it the line-scoped
  // write tools (Edit, apply_patch Update) can check their needle against the
  // text the model is holding instead of refusing the file outright — 8 of 65
  // gate refusals in the 2026-08/09 corpus were Edits of an injected
  // MEMORY.md or rule, each answered by a view='full' re-read of a file the
  // model had just been shown. Whole-file writes (Write, Delete File) still
  // need a real Read: a truncated MEMORY.md written back from the view would
  // lose its tail. Never set by a Read tool call or a clip-pin marker.
  injectedView?: string
  // tool_use id of the Read that carried this content to the model. The
  // dedup stand-down uses it to check whether that tool_result is still
  // intact in the transcript (client-side clip paths rewrite old results to
  // stubs without touching this cache — see FileReadTool's
  // clientClippingDetection.ts). Absent for entries not written by a Read
  // tool call (Edit/Write, auto-injection, contexts without a toolUseId),
  // which keep the pre-existing always-armed dedup behavior.
  //
  // Transcript-scoped: the id is only meaningful against the messages array
  // of the context where the Read ran. A clone that crosses contexts (fork
  // subagents inherit parent messages, so ids normally still resolve;
  // resume reloads the same transcript) can in rare flows carry an id whose
  // tool_result is absent from the new context's messages — the scanner
  // then reports "missing" and dedup stands down, costing one re-send.
  // Fail-safe by design; do not rely on the id resolving outside its
  // original transcript.
  toolUseId?: string
  // How many times the clip-pin stand-down has already re-sent this exact
  // (path, offset, limit) without the copy surviving. The bound for the cases
  // a pin cannot cover: contexts that carry no toolUseId to pin (MCP/SDK,
  // @-mentions, MagicDocs, SessionMemory) and the killswitch path. Lives on
  // the entry on purpose — it then resets for free on exactly the events that
  // should reset it (range switch, Edit/Write, LRU eviction all replace or
  // drop the entry), so there is no registry to bound, evict or sweep.
  standDownStrikes?: number
  // The stand-down already gave up on re-sending this (path, offset, limit)
  // and served a structural outline (or head slice) instead. Holding that
  // decision here is what makes the fallback TERMINATE: the previous design
  // deleted the entry to re-arm, so the next read was a first read and paid
  // another full body, and the cycle never converged.
  //
  // `message` is the rendered fallback, replayed verbatim rather than
  // re-scanned — the entry already carries `content`, so a few KB more is
  // noise next to a second scanFile per read.
  //
  // `epoch` is stableStubState's stand-down epoch at the time it was written.
  // Together with `timestamp` (mtime) and `replays` it is what lets this state
  // be sticky WITHOUT being permanent. Five ways out: a changed mtime, a range
  // switch (replaces this entry), LRU eviction, a main-thread compaction
  // (which advances the epoch), and — the backstop that does not depend on
  // anything external happening — spending `replays`. Same five as the branch
  // in FileReadTool.ts that reads this field; keep the two counts in step.
  //
  // An Edit/Write replacing the entry is NOT on that list, though it looks
  // like the obvious one. See below: while this marker stands those tools are
  // refused, so they can never be what clears it.
  //
  // Always written with isPartialView: true, so Edit/Write still demand a real
  // Read first (FileEditTool.ts, FileWriteTool.ts, applyPatch.ts and
  // NotebookEditTool.ts all check it). That refusal is CORRECT — the model has
  // seen an outline, not the body, and letting it edit from that trades a
  // stalled loop for a blind write. But it is also why `replays` is not
  // optional: with no budget the refusal never lifts, because the replay
  // returns without rewriting this entry, so Read can never clear what Edit is
  // waiting on. The delete-to-re-arm version this replaced refused too, and
  // then handed over a body on the next read; the budget restores that ending.
  standDownOutline?: {
    message: string
    servedOutline: boolean
    epoch: number
    // Replays already served for this marker. At STICKY_REPLAY_BUDGET the
    // marker is spent and Read falls back to delete-and-re-arm.
    replays: number
  }
  // Earlier reads of THIS same version of the file, carried forward by
  // `carrySeenRanges` when one Read replaces another. Without it an entry
  // stands for the LAST read alone, so walking a file in N slices accumulates
  // no coverage at all, and a narrow Read on top of a full one silently
  // destroys what the full one proved. Measured over 683 sessions: 28 of 37
  // `coverage:unseen-region` refusals were for hunks whose old side sat
  // verbatim in lines the model had already been shown.
  //
  // Consumed only by the coverage lane (`coveredSegments` in
  // readBeforeEditMessages.ts), which merges these with the entry's own slice
  // into CONTIGUOUS segments — a run of lines nobody read is never covered,
  // however the slices are arranged around it.
  //
  // Correctness rests on one rule, enforced in `carrySeenRanges`: the list is
  // dropped the moment `timestamp` changes, so bytes from a previous version
  // of the file can never authorize a write.
  seenRanges?: SeenRange[]
}

/**
 * Called when an entry stops vouching for the tool_use that carried its
 * content, so the clip pin on that result can be released.
 *
 * Injected rather than imported: this module is depended on by nearly
 * everything that touches files, and importing stableStubState directly took
 * its reachable-module count from 1 to the whole app AND created a value cycle
 * back to itself (fileStateCache → stableStubState → tokenEstimation →
 * utils/messages → … → utils/claudemd → fileStateCache). Keeping the cache a
 * leaf is what stops `mcp.ts` and the workflow entrypoints from dragging the
 * entire graph in, and what keeps colocated tests free of the module-init
 * ordering hazard testing.md warns about.
 *
 * If nobody registers a handler the pins are simply never released early —
 * they still age out via MAX_SHIELDED_PASSES. That is the pre-dispose-hook
 * behavior, i.e. safe.
 */
type PinReleaseHandler = (toolUseId: string) => void
let releasePin: PinReleaseHandler | undefined

export function setPinReleaseHandler(handler: PinReleaseHandler): void {
  releasePin = handler
}

// Default max entries for read file state caches
export const READ_FILE_STATE_CACHE_SIZE = 100

// Default size limit for file state caches (25MB)
// This prevents unbounded memory growth from large file contents
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

/**
 * Bounds on the accumulated slice list, per entry.
 *
 * 64 KB is 8x the slice-walk the session corpus actually shows (~8 reads of
 * 2-4 KB of one file before the write) and, more to the point, it is well
 * inside the cache's own budget: 25 MB over 100 entries leaves ~256 KB per
 * entry, so capping at the per-read ceiling (MAX_OUTPUT_SIZE, also 256 KB)
 * would start evicting by SIZE in sessions that walk many files. That trades a
 * coverage refusal for a "has not been read yet" one, which is the worse of
 * the two.
 *
 * The newest slice is never dropped to fit: it was legally this entry's whole
 * `content` a moment earlier, so keeping it costs nothing the cache was not
 * already paying. That is what lets the clobber case — a narrow Read landing
 * on top of a full one — survive on a file larger than the budget.
 */
export const SEEN_RANGES_MAX_BYTES = 64 * 1024
export const SEEN_RANGES_MAX_COUNT = 32

/**
 * What `next` carries forward from the entry it replaces. Pure — it returns
 * the list and writes nothing; `set` is what stores it.
 *
 * `undefined` means "carry nothing", which is the answer in three cases:
 *
 * 1. there is no predecessor;
 * 2. `timestamp` moved — a different mtime means different bytes, so every
 *    earlier slice describes a file that no longer exists. This is also what
 *    makes Edit/Write/apply_patch drop the history for free: they write the
 *    post-write mtime;
 * 3. `next` stands for the whole file, where `seenRegionCovers` short-circuits
 *    anyway — holding slices there would be pure memory.
 */
export function carrySeenRanges(
  prev: FileState | undefined,
  next: FileState,
): SeenRange[] | undefined {
  if (!prev || prev.timestamp !== next.timestamp) return undefined
  // Same predicate as isWholeFileView (readBeforeEditMessages.ts), inlined to
  // keep this module a leaf — see the note on setPinReleaseHandler. Keep the
  // two in step.
  if (
    (next.offset === undefined || next.offset === 1) &&
    next.limit === undefined
  ) {
    return undefined
  }
  const incoming: SeenRange = { offset: prev.offset ?? 1, content: prev.content }
  // Re-reading the same slice must not duplicate it.
  const carried = (prev.seenRanges ?? []).filter(
    r => r.offset !== incoming.offset || r.content !== incoming.content,
  )
  carried.push(incoming)
  let bytes = carried.reduce((n, r) => n + Buffer.byteLength(r.content), 0)
  while (
    carried.length > 1 &&
    (carried.length > SEEN_RANGES_MAX_COUNT || bytes > SEEN_RANGES_MAX_BYTES)
  ) {
    bytes -= Buffer.byteLength(carried[0]!.content)
    carried.shift()
  }
  return carried
}

/** Bytes an entry retains, including what it carries for the coverage lane. */
function entryBytes(value: FileState): number {
  let bytes = Buffer.byteLength(value.content)
  if (value.injectedView !== undefined) {
    bytes += Buffer.byteLength(value.injectedView)
  }
  for (const range of value.seenRanges ?? []) {
    bytes += Buffer.byteLength(range.content)
  }
  return bytes
}

/**
 * A file state cache that normalizes all path keys before access.
 * This ensures consistent cache hits regardless of whether callers pass
 * relative vs absolute paths with redundant segments (e.g. /foo/../bar)
 * or mixed path separators on Windows (/ vs \).
 */
export class FileStateCache {
  private cache: LRUCache<string, FileState>
  /**
   * tool_use ids this cache accepted through `set` — i.e. the pins it is
   * entitled to release. Entries arriving via `load` (how cloneFileStateCache
   * copies a parent's state) are held WITHOUT ownership: a forked sub-agent
   * runs on such a clone and `clear()`s it on exit, which disposes every
   * inherited entry. Releasing there would unpin blocks the PARENT's entries
   * still vouch for, so the parent would believe its content is protected
   * while it had quietly become clippable again.
   */
  private readonly ownedToolUseIds = new Set<string>()
  /**
   * Set for the duration of one `set` when the incoming entry carries the SAME
   * tool_use id as the one it replaces. lru-cache fires `dispose(old, 'set')`
   * BEFORE storing the new value, so without this the handover reads as an
   * abandonment: the pin gets released and then re-claimed by the new entry,
   * leaving this cache owning an id that is no longer pinned.
   */
  private handingOver: string | undefined

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      // Counts the carried slices too: they are real retained bytes, and a
      // size cap blind to them stops bounding the cache.
      sizeCalculation: value => Math.max(1, entryBytes(value)),
      // A clip-pin protects the tool_result this entry points at, for exactly
      // as long as the entry vouches that the model still needs that content.
      // The moment the entry stops pointing at it — replaced by a different
      // range, overwritten by Edit/Write, deleted, or LRU-evicted — the pin
      // has no owner left. Releasing it here (every dispose reason, since all
      // four cases end the ownership) is structural: doing it at the call
      // sites leaked one pin per abandoned range, and a leaked pin keeps its
      // block mutable, which freezes the prompt-cache clip frontier at that
      // block's index for the rest of the session.
      dispose: value => {
        const id = value.toolUseId
        // delete() doubles as the ownership test: only the cache that took
        // this id in releases it, and only once.
        if (!id || id === this.handingOver) return
        if (this.ownedToolUseIds.delete(id)) releasePin?.(id)
      },
    })
  }

  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key))
  }

  /**
   * `adopt: false` inserts the entry WITHOUT claiming its pin — for callers
   * copying entries another live cache still owns (mergeFileStateCaches). Two
   * owners of one tool_use id means the first dispose releases a pin the other
   * still vouches for.
   */
  set(key: string, value: FileState, options?: { adopt?: boolean }): this {
    const normalized = normalize(key)
    const prev = this.cache.peek(normalized)
    const prevId = prev?.toolUseId
    // Mutated rather than replaced by a copy, like setStandDownStrikes: the
    // ownership check below tests IDENTITY against `value`, so storing a copy
    // here would silently stop this cache claiming pins. Only assigned when
    // there is something to carry, so an entry arriving from another cache
    // (mergeFileStateCaches) keeps its own list.
    const carried = carrySeenRanges(prev, value)
    if (carried) value.seenRanges = carried
    this.handingOver =
      prevId !== undefined && prevId === value.toolUseId ? prevId : undefined
    // Overwriting disposes the previous value first, releasing its pin; only
    // then does this cache claim the incoming id, so a same-key replacement
    // hands ownership over rather than dropping it.
    this.cache.set(normalized, value)
    this.handingOver = undefined
    // Claim ownership only if the entry actually landed. lru-cache refuses a
    // value over maxEntrySize — it deletes the key and stores nothing, so no
    // dispose ever fires for it, and an id claimed for an absent entry would
    // sit in this Set for the life of the session.
    if (
      options?.adopt !== false &&
      value.toolUseId &&
      this.cache.peek(normalized) === value
    ) {
      this.ownedToolUseIds.add(value.toolUseId)
    }
    return this
  }

  /**
   * Carry a stand-down strike count onto whatever entry is currently stored,
   * mutated in place. In place because the re-send that produced this count
   * has already overwritten the entry via `set`, and re-`set`ting a copy just
   * to change a counter would churn the pin ownership for nothing.
   */
  setStandDownStrikes(key: string, strikes: number): void {
    const value = this.cache.peek(normalize(key))
    if (value) value.standDownStrikes = strikes
  }

  /**
   * Charge one replay against the sticky stand-down marker, mutated in place,
   * and report how many have now been served.
   *
   * In place for the same reason as setStandDownStrikes above — churning the
   * entry to move a counter buys nothing. (An earlier version of this comment
   * claimed a sharper reason, that a re-`set` would release a pin via the
   * dispose hook. That was wrong: the sticky entry carries NO toolUseId, and
   * the hook's first line returns early without one.)
   *
   * Returns 0 when there is no marker. Callers use `<= budget` to decide, so
   * a 0 reads as "serve" — which is right for the ordinary case but NOT for a
   * concurrent one: two Reads of the same path can interleave across the stat
   * that precedes this call, and the second may charge an entry the first
   * already deleted, serving one stale uncharged outline. That costs an extra
   * outline, never an extra body, and cannot livelock, since the winning read
   * has already replaced the entry.
   */
  chargeStandDownReplay(key: string): number {
    const value = this.cache.peek(normalize(key))
    if (!value?.standDownOutline) return 0
    value.standDownOutline.replays += 1
    return value.standDownOutline.replays
  }


  has(key: string): boolean {
    return this.cache.has(normalize(key))
  }

  /**
   * Take over `donor`'s pin ownership. For the caller that REPLACES a live
   * cache with a derived one (mergeReplacingLiveCache): the
   * donor is about to be dropped, and `LRUCache.dispose` does not run on GC, so
   * without this every pin the donor owned becomes ownerless — no cache is
   * entitled to release it and it stalls the clip frontier until it ages out.
   * Clearing the donor keeps the "exactly one owner" invariant intact.
   */
  transferOwnershipFrom(donor: FileStateCache): void {
    if (donor === this) return
    // Only ids this cache can actually release. A donor id whose entry lost
    // the merge's timestamp race is not in here at all, and adopting it would
    // park a pin on a cache with no entry to ever dispose it — the same
    // ownerless leak this method exists to prevent, arriving from the other
    // side.
    const live = new Set<string>()
    for (const [, value] of this.cache.entries()) {
      if (value.toolUseId) live.add(value.toolUseId)
    }
    for (const id of donor.ownedToolUseIds) {
      if (live.has(id)) this.ownedToolUseIds.add(id)
    }
    // The rest are dropped: the donor is being discarded, and an id with no
    // entry on either side has nothing left to vouch for it. Those pins age
    // out via MAX_SHIELDED_PASSES instead of being released early.
    donor.ownedToolUseIds.clear()
  }

  delete(key: string): boolean {
    return this.cache.delete(normalize(key))
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  get max(): number {
    return this.cache.max
  }

  get maxSize(): number {
    return this.cache.maxSize
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize
  }

  keys(): Generator<string> {
    return this.cache.keys()
  }

  entries(): Generator<[string, FileState]> {
    return this.cache.entries()
  }

  dump(): ReturnType<LRUCache<string, FileState>['dump']> {
    return this.cache.dump()
  }

  load(entries: ReturnType<LRUCache<string, FileState>['dump']>): void {
    this.cache.load(entries)
  }
}

/**
 * Factory function to create a size-limited FileStateCache.
 * Uses LRUCache's built-in size-based eviction to prevent memory bloat.
 * Note: Images are not cached (see FileReadTool) so size limit is mainly
 * for large text files, notebooks, and other editable content.
 */
export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

// Helper function to convert cache to object (used by compact.ts)
export function cacheToObject(
  cache: FileStateCache,
): Record<string, FileState> {
  return Object.fromEntries(cache.entries())
}

// Helper function to get all keys from cache (used by several components)
export function cacheKeys(cache: FileStateCache): string[] {
  return Array.from(cache.keys())
}

// Helper function to clone a FileStateCache
// Preserves size limit configuration from the source cache
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const cloned = createFileStateCacheWithSizeLimit(cache.max, cache.maxSize)
  cloned.load(cache.dump())
  return cloned
}

/**
 * Merge two file state caches, with more recent entries (by timestamp)
 * overriding older ones.
 *
 * Pin ownership depends on what the CALLER does with the result, which is the
 * one thing this function cannot see:
 *
 * - default (a transient view — the inputs stay live): owns nothing. `first`
 *   arrives via `load` and `second`'s entries via `adopt:false`, so no id gets a
 *   second owner. Two live caches each believing they own one id means whichever
 *   disposes first releases a pin the other still vouches for, re-arming the
 *   clip → re-read loop for a file the survivor thinks is protected.
 * - the result is assigned OVER either input: use `mergeReplacingLiveCache`
 *   instead, which takes both inputs' ownership with it via
 *   `transferOwnershipFrom`. Without that the merge is a guaranteed leak — the
 *   discarded owner's set goes with it, `dispose` never runs on GC, and from
 *   that point NO pin in the session can be released early by anyone.
 */
export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath)
    // Only override if the new entry is more recent
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState, { adopt: false })
    }
  }
  return merged
}

/**
 * Merge for the case where the result is assigned OVER `live` — the REPL
 * restore and the speculation injection both do `live = merge(live, extracted)`.
 *
 * Ownership has to move with it. A plain `mergeFileStateCaches` here is a
 * guaranteed leak, not a theoretical one: `LRUCache.dispose` does not run on
 * GC, so the discarded owner's set vanishes with it and from that point NOTHING
 * in the session can release a pin early.
 *
 * This is a separate FUNCTION rather than an option on the merge because the
 * option was one — a `replacesInputs?: boolean` defaulting to the leaking
 * behavior, which an audit found no test could catch at any of its call sites.
 * A caller cannot forget an argument that does not exist.
 */
export function mergeReplacingLiveCache(
  live: FileStateCache,
  incoming: FileStateCache,
): FileStateCache {
  const merged = mergeFileStateCaches(live, incoming)
  merged.transferOwnershipFrom(live)
  merged.transferOwnershipFrom(incoming)
  return merged
}
