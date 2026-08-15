import { beforeEach, describe, expect, test } from 'bun:test'
import {
  carrySeenRanges,
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  mergeReplacingLiveCache,
  SEEN_RANGES_MAX_BYTES,
  SEEN_RANGES_MAX_COUNT,
  type FileState,
} from 'src/shared/fs/fileStateCache.js'
import {
  _resetAllClippedIdsForTesting,
  isPinRegistered,
  pinToolResult,
} from 'src/agent/compact/stableStubState.js'

/**
 * Coverage for FileStateCache's PIN OWNERSHIP, which had none.
 *
 * The cache is one of the four release paths for a clip-pin: its `dispose` hook
 * is what stops a pin leaking when the entry that vouched for it goes away
 * (range switch, Edit/Write, delete, LRU eviction). A leaked pin keeps its
 * tool_result block mutable, which freezes the prompt-cache clip frontier at
 * that block's index for the rest of the session — expensive and completely
 * invisible. The opposite error is worse: releasing a pin this cache does NOT
 * own leaves the real owner believing its content is protected when it has
 * quietly become clippable again.
 *
 * Both failure modes are silent at runtime, which is exactly why they need
 * tests rather than review.
 */
describe('FileStateCache — clip-pin ownership', () => {
  const entry = (toolUseId?: string, content = 'x'): FileState => ({
    content,
    timestamp: Date.now(),
    offset: undefined,
    limit: undefined,
    ...(toolUseId ? { toolUseId } : {}),
  })

  const makeCache = (maxEntries = 10, maxBytes = 1024 * 1024) =>
    createFileStateCacheWithSizeLimit(maxEntries, maxBytes)

  beforeEach(() => {
    _resetAllClippedIdsForTesting()
  })

  test('a same-key replacement hands ownership over rather than dropping it', () => {
    const cache = makeCache()
    pinToolResult('toolu_old')
    pinToolResult('toolu_new')
    cache.set('/a.ts', entry('toolu_old'))

    // The range switch the pin exists to survive: same file, new copy.
    cache.set('/a.ts', entry('toolu_new'))

    // The abandoned copy's pin is released — nothing vouches for it now.
    expect(isPinRegistered('toolu_old')).toBe(false)
    // The incoming one is NOT collateral damage of its own insertion.
    expect(isPinRegistered('toolu_new')).toBe(true)
  })

  test('a same-id re-set is a handover, not an abandonment — the pin survives', () => {
    // DEFENSIVE GUARD, named for what it pins: production Read paths always
    // write a FRESH tool_use id per call, so prevId === newId is not a known
    // reachable flow today. If a future caller refreshes an entry in place
    // with the same id, lru-cache still fires dispose(old, 'set') BEFORE the
    // new value lands; without the handingOver suppression that dispose
    // releases the pin and the cache then claims ownership of an id that is
    // no longer pinned.
    const cache = makeCache()
    pinToolResult('toolu_same')
    cache.set('/a.ts', entry('toolu_same'))
    cache.set('/a.ts', entry('toolu_same', 'refreshed'))
    expect(isPinRegistered('toolu_same')).toBe(true)
    // Ownership also survived the handover: deleting now releases, once.
    cache.delete('/a.ts')
    expect(isPinRegistered('toolu_same')).toBe(false)
  })

  test('delete and clear release, LRU eviction releases too', () => {
    const cache = makeCache()
    pinToolResult('toolu_del')
    cache.set('/del.ts', entry('toolu_del'))
    cache.delete('/del.ts')
    expect(isPinRegistered('toolu_del')).toBe(false)

    pinToolResult('toolu_clear')
    cache.set('/clear.ts', entry('toolu_clear'))
    cache.clear()
    expect(isPinRegistered('toolu_clear')).toBe(false)

    // Eviction is the one no call site can see coming, so it is the one that
    // leaked before the dispose hook existed.
    const tiny = makeCache(2)
    pinToolResult('toolu_evicted')
    tiny.set('/1.ts', entry('toolu_evicted'))
    tiny.set('/2.ts', entry('toolu_b'))
    tiny.set('/3.ts', entry('toolu_c'))
    expect(tiny.has('/1.ts')).toBe(false)
    expect(isPinRegistered('toolu_evicted')).toBe(false)
  })

  test('normalized keys mean /a/../b.ts and /b.ts are the same entry', () => {
    const cache = makeCache()
    pinToolResult('toolu_first')
    cache.set('/a/../b.ts', entry('toolu_first'))
    // If normalization were skipped here the "replacement" would be a second
    // entry and the first pin would leak with no owner able to release it.
    cache.set('/b.ts', entry('toolu_second'))
    expect(cache.size).toBe(1)
    expect(isPinRegistered('toolu_first')).toBe(false)
  })

  test('a clone holds inherited pins WITHOUT owning them', () => {
    // This is the fork path: a sub-agent runs on a clone of the parent's state
    // and clears it on exit. Releasing there would unpin blocks the PARENT
    // still vouches for.
    const parent = makeCache()
    pinToolResult('toolu_parent')
    parent.set('/a.ts', entry('toolu_parent'))

    const forked = cloneFileStateCache(parent)
    expect(forked.get('/a.ts')?.toolUseId).toBe('toolu_parent')
    forked.clear()

    expect(isPinRegistered('toolu_parent')).toBe(true)
    // …and the parent can still release it when its own entry goes away.
    parent.delete('/a.ts')
    expect(isPinRegistered('toolu_parent')).toBe(false)
  })

  test('a merge does not create a second owner of one id', () => {
    const first = makeCache()
    const second = makeCache()
    pinToolResult('toolu_second_owned')
    second.set('/b.ts', entry('toolu_second_owned'))

    const merged = mergeFileStateCaches(first, second)
    expect(merged.get('/b.ts')?.toolUseId).toBe('toolu_second_owned')

    // Discarding the merged view must not release a pin `second` still owns —
    // that is the double-ownership bug: whichever cache disposed first would
    // unpin a block the survivor believed was protected.
    merged.clear()
    expect(isPinRegistered('toolu_second_owned')).toBe(true)

    second.delete('/b.ts')
    expect(isPinRegistered('toolu_second_owned')).toBe(false)
  })

  test('mergeReplacingLiveCache inherits ownership from BOTH inputs', () => {
    // The dominant call shape (REPL restore, speculation injection) is
    // `live = merge(live, extracted)` — the result is assigned OVER the live
    // cache. A non-owning merge there is a guaranteed leak, not a theoretical
    // one: LRUCache.dispose does not run on GC, so the discarded owner's set
    // vanishes with it and from that point NOTHING in the session can release a
    // pin early. That is the exact failure the dispose hook was written to
    // prevent, reintroduced by the fix for double-ownership.
    //
    // This used to be `mergeFileStateCaches(..., { replacesInputs: true })`. An
    // audit pointed out that deleting the option from all three call sites left
    // every test green — this file covered the API, nothing covered the callers.
    // Splitting it into a second named function is the fix: the caller can no
    // longer forget an argument that does not exist. The remaining risk is
    // calling the wrong function, which is visible at the call site in a way a
    // missing optional boolean is not.
    const live = makeCache()
    const extracted = makeCache()
    pinToolResult('toolu_live')
    pinToolResult('toolu_extracted')
    live.set('/a.ts', entry('toolu_live'))
    extracted.set('/b.ts', entry('toolu_extracted'))

    const merged = mergeReplacingLiveCache(live, extracted)
    // The donors kept nothing, so they cannot double-release…
    live.clear()
    extracted.clear()
    expect(isPinRegistered('toolu_live')).toBe(true)
    expect(isPinRegistered('toolu_extracted')).toBe(true)

    // …and the survivor can release both, which is the whole point.
    merged.delete('/a.ts')
    expect(isPinRegistered('toolu_live')).toBe(false)
    merged.delete('/b.ts')
    expect(isPinRegistered('toolu_extracted')).toBe(false)

    // HONEST SCOPE: `transferOwnershipFrom` also filters out donor ids whose
    // entry LOST the merge's timestamp race, so they are not adopted by a cache
    // that has no entry to ever dispose them. That filter is not covered here
    // and cannot be — release only ever happens through an entry, so an id
    // parked in the owned set with no entry behind it produces no observable
    // behavior either way. It is memory hygiene, and asserting around it would
    // be a test that passes with the filter removed.
  })

  test('an entry rejected for size is not stored and leaves neighbours alone', () => {
    // lru-cache refuses a value over maxEntrySize: it deletes the key and
    // stores nothing, so no dispose ever fires for it.
    //
    // HONEST SCOPE: `set` also guards its ownership claim with
    // `peek(normalized) === value` so a rejected entry's id does not sit in the
    // owned set forever. That guard is NOT covered here and cannot be — the
    // owned set is private, nothing disposes an entry that never landed, and
    // tool_use ids are unique, so removing the guard changes no observable
    // behavior. It prevents an unbounded leak of id strings, nothing more.
    // Asserting around it would be a test that passes either way.
    const cache = makeCache(10, 64)
    pinToolResult('toolu_toobig')
    cache.set('/big.ts', entry('toolu_toobig', 'y'.repeat(4096)))
    expect(cache.has('/big.ts')).toBe(false)
    // No owner, so no release — and the rejection must not disturb the pins of
    // entries that DID land.
    cache.set('/small.ts', entry('toolu_small'))
    cache.delete('/small.ts')
    expect(isPinRegistered('toolu_small')).toBe(false)
    expect(isPinRegistered('toolu_toobig')).toBe(true)
  })

  test('entries with no toolUseId are inert', () => {
    const cache = makeCache()
    cache.set('/plain.ts', entry())
    expect(() => cache.delete('/plain.ts')).not.toThrow()
    expect(cache.size).toBe(0)
  })
})

/**
 * chargeStandDownReplay is the budget that stops the clip-pin sticky marker
 * from refusing a readable file forever. It was covered only transitively
 * through FileReadTool, which left its two edge answers — and the concurrency
 * caveat its own doc comment describes — unexercised.
 */
describe('FileStateCache — stand-down replay budget', () => {
  const marked = (replays: number): FileState => ({
    content: 'x',
    timestamp: 1,
    offset: 1,
    limit: undefined,
    isPartialView: true,
    standDownOutline: {
      message: '<outline>',
      servedOutline: true,
      epoch: 0,
      replays,
    },
  })

  const makeCache = () => createFileStateCacheWithSizeLimit(10, 1024 * 1024)

  test('counts up from the stored value and reports the new total', () => {
    const cache = makeCache()
    cache.set('/a.ts', marked(0))
    expect(cache.chargeStandDownReplay('/a.ts')).toBe(1)
    expect(cache.chargeStandDownReplay('/a.ts')).toBe(2)
    expect(cache.get('/a.ts')?.standDownOutline?.replays).toBe(2)
  })

  test('mutates in place, so the entry keeps its identity and its size', () => {
    // In place is the whole point: a re-`set` would churn the LRU. Identity is
    // the observable — same object, so nothing downstream holding a reference
    // sees a stale counter, and neither `content` nor `seenRanges` is touched,
    // so the cache's byte accounting stays exact.
    const cache = makeCache()
    cache.set('/a.ts', marked(0))
    const before = cache.get('/a.ts')
    const sizeBefore = cache.calculatedSize
    cache.chargeStandDownReplay('/a.ts')
    expect(cache.get('/a.ts')).toBe(before!)
    expect(cache.calculatedSize).toBe(sizeBefore)
  })

  test('returns 0 for a missing entry and for one with no marker', () => {
    // Both answers matter to the caller, which decides with `<= budget`. The
    // missing-entry case is the concurrency window the doc comment describes:
    // a parallel Read can delete the entry between the caller's `get` and this
    // call, and the 0 then reads as "serve", costing one stale outline. It
    // must not throw, and it must not resurrect anything.
    const cache = makeCache()
    expect(cache.chargeStandDownReplay('/gone.ts')).toBe(0)
    expect(cache.has('/gone.ts')).toBe(false)

    cache.set('/plain.ts', {
      content: 'x',
      timestamp: 1,
      offset: 1,
      limit: undefined,
    })
    expect(cache.chargeStandDownReplay('/plain.ts')).toBe(0)
    expect(cache.get('/plain.ts')?.standDownOutline).toBeUndefined()
  })

  test('normalizes the key like every other accessor', () => {
    // set/get/delete all normalize; if this one did not, the budget would
    // never be charged for a path spelled differently at the two call sites
    // and the marker would be permanent again.
    const cache = makeCache()
    cache.set('/dir/a.ts', marked(0))
    expect(cache.chargeStandDownReplay('/dir/./a.ts')).toBe(1)
  })
})

/**
 * Coverage for the ACCUMULATED read ranges.
 *
 * An entry used to stand for the last Read alone, so a file walked in slices
 * accumulated no coverage and a narrow Read landing on a full one destroyed
 * what the full one had proved. Both are silent: the model is refused with a
 * message about lines it has already been shown.
 *
 * The dangerous direction is the other one, and it is what most of these pin:
 * carrying a slice one byte past the moment it stopped describing the file on
 * disk turns the coverage gate into a rubber stamp for a blind write.
 */
describe('FileStateCache — carrySeenRanges', () => {
  const makeCache = (maxEntries = 10, maxBytes = 8 * 1024 * 1024) =>
    createFileStateCacheWithSizeLimit(maxEntries, maxBytes)

  /** A Read of `count` lines starting at `offset`, of one version of a file. */
  const range = (
    offset: number,
    count: number,
    timestamp = 1000,
    fill = 'x',
  ): FileState => ({
    content: Array.from(
      { length: count },
      (_, i) => `${fill}${offset + i}`,
    ).join('\n'),
    timestamp,
    offset,
    limit: count,
  })

  const whole = (content: string, timestamp = 1000): FileState => ({
    content,
    timestamp,
    offset: undefined,
    limit: undefined,
  })

  test('a second range read carries the first forward', () => {
    const cache = makeCache()
    cache.set('/a.ts', range(1, 3))
    cache.set('/a.ts', range(50, 3))

    const stored = cache.get('/a.ts')!
    expect(stored.seenRanges).toHaveLength(1)
    expect(stored.seenRanges![0]!.offset).toBe(1)
    // The entry itself still describes only the newest read; the carried list
    // is additive, not a replacement.
    expect(stored.offset).toBe(50)
  })

  test('a changed mtime drops everything carried', () => {
    // The one invariant the whole lane rests on. Slices describe bytes; a new
    // mtime means different bytes, and carrying them would let a write be
    // authorized against a version of the file that no longer exists.
    const cache = makeCache()
    cache.set('/a.ts', range(1, 3, 1000))
    cache.set('/a.ts', range(50, 3, 1000))
    cache.set('/a.ts', range(90, 3, 2000))

    expect(cache.get('/a.ts')!.seenRanges).toBeUndefined()
  })

  test('an Edit/Write entry carries nothing, and a later range starts fresh', () => {
    // Write tools store the post-write mtime and the whole file, so they hit
    // both exits at once. Pinned because it is what makes "edit then re-read a
    // slice" behave like a first read rather than inheriting pre-edit lines.
    const cache = makeCache()
    cache.set('/a.ts', range(1, 3, 1000))
    cache.set('/a.ts', whole('new content', 2000))
    expect(cache.get('/a.ts')!.seenRanges).toBeUndefined()

    cache.set('/a.ts', range(50, 3, 2000))
    const stored = cache.get('/a.ts')!
    expect(stored.seenRanges).toHaveLength(1)
    expect(stored.seenRanges![0]!.content).toBe('new content')
  })

  test('a whole-file read drops the list instead of hoarding it', () => {
    // seenRegionCovers short-circuits on a whole-file entry, so slices there
    // are pure memory. This is also the shape Edit/Write write.
    const cache = makeCache()
    cache.set('/a.ts', range(1, 3))
    cache.set('/a.ts', range(50, 3))
    cache.set('/a.ts', whole('everything'))

    expect(cache.get('/a.ts')!.seenRanges).toBeUndefined()
  })

  test('re-reading the same slice does not duplicate it', () => {
    const cache = makeCache()
    cache.set('/a.ts', range(1, 3))
    cache.set('/a.ts', range(50, 3))
    cache.set('/a.ts', range(1, 3))
    cache.set('/a.ts', range(50, 3))

    // Order is by recency, because that is the order the caps evict in — the
    // assertion is that four reads of two slices leave two entries, not four.
    const offsets = cache.get('/a.ts')!.seenRanges!.map(r => r.offset)
    expect([...offsets].sort((a, b) => a - b)).toEqual([1, 50])
  })

  test('the byte cap drops the OLDEST slices', () => {
    const cache = makeCache()
    const big = (offset: number): FileState => ({
      content: 'y'.repeat(32 * 1024),
      timestamp: 1000,
      offset,
      limit: 10,
    })
    cache.set('/a.ts', big(1))
    cache.set('/a.ts', big(100))
    cache.set('/a.ts', big(200))
    cache.set('/a.ts', big(300))

    const offsets = cache.get('/a.ts')!.seenRanges!.map(r => r.offset)
    // 3 x 32 KB is over the 64 KB budget, so the first read goes.
    expect(offsets).toEqual([100, 200])
  })

  test('the newest slice survives even when it alone is over the budget', () => {
    // The clobber case on a big file: a narrow Read landing on a full one. That
    // full body was legally this entry's `content` a moment earlier, so keeping
    // it costs the cache nothing it was not already paying — and dropping it is
    // exactly the regression this whole change exists to fix.
    const cache = makeCache()
    cache.set('/a.ts', whole('z'.repeat(SEEN_RANGES_MAX_BYTES * 2)))
    cache.set('/a.ts', range(50, 3))

    const stored = cache.get('/a.ts')!
    expect(stored.seenRanges).toHaveLength(1)
    expect(stored.seenRanges![0]!.content.length).toBe(
      SEEN_RANGES_MAX_BYTES * 2,
    )
  })

  test('the count cap bounds the list at SEEN_RANGES_MAX_COUNT', () => {
    const cache = makeCache()
    for (let i = 0; i < SEEN_RANGES_MAX_COUNT + 6; i++) {
      cache.set('/a.ts', range(i * 10 + 1, 1))
    }
    const ranges = cache.get('/a.ts')!.seenRanges!
    expect(ranges).toHaveLength(SEEN_RANGES_MAX_COUNT)
    // Oldest first out, newest kept.
    expect(ranges[0]!.offset).toBeGreaterThan(1)
    expect(ranges[ranges.length - 1]!.offset).toBe(
      (SEEN_RANGES_MAX_COUNT + 4) * 10 + 1,
    )
  })

  test('calculatedSize counts the carried bytes', () => {
    // Without this the 25 MB cap stops bounding the cache: the carried slices
    // are real retained memory and a size calculation blind to them under-
    // reports every accumulating entry.
    const cache = makeCache()
    const slice = (offset: number): FileState => ({
      content: 'w'.repeat(1024),
      timestamp: 1000,
      offset,
      limit: 10,
    })
    cache.set('/a.ts', slice(1))
    const oneRead = cache.calculatedSize
    cache.set('/a.ts', slice(100))

    expect(cache.calculatedSize).toBe(oneRead * 2)
  })

  test('carrySeenRanges is pure — it does not write to either argument', () => {
    const prev = range(1, 3)
    const next = range(50, 3)
    const carried = carrySeenRanges(prev, next)

    expect(carried).toHaveLength(1)
    expect(prev.seenRanges).toBeUndefined()
    expect(next.seenRanges).toBeUndefined()
  })

  test('an entry merged in from another cache keeps its own list', () => {
    // mergeFileStateCaches only writes an entry whose timestamp is NEWER, which
    // is the "carry nothing" case — so `set` must leave the incoming list
    // alone rather than clearing it. Clearing here would silently drop the
    // coverage a resumed or forked context had already earned.
    const live = makeCache()
    const incoming = makeCache()
    live.set('/a.ts', range(1, 3, 1000))
    const withRanges: FileState = { ...range(50, 3, 2000), seenRanges: [{ offset: 10, content: 'x10' }] }
    incoming.set('/a.ts', withRanges)

    const merged = mergeFileStateCaches(live, incoming)
    expect(merged.get('/a.ts')!.seenRanges).toEqual([
      { offset: 10, content: 'x10' },
    ])
  })
})
