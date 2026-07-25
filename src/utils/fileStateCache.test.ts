import { beforeEach, describe, expect, test } from 'bun:test'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  type FileState,
} from './fileStateCache.js'
import {
  _resetAllClippedIdsForTesting,
  isPinRegistered,
  pinToolResult,
} from '../services/compact/stableStubState.js'

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

  test('replacesInputs: the merge inherits ownership from BOTH inputs', () => {
    // The dominant call shape (REPL restore, speculation injection) is
    // `live = mergeFileStateCaches(live, extracted)` — the result is assigned
    // OVER the live cache. A non-owning merge there is a guaranteed leak, not a
    // theoretical one: LRUCache.dispose does not run on GC, so the discarded
    // owner's set vanishes with it and from that point NOTHING in the session
    // can release a pin early. That is the exact failure the dispose hook was
    // written to prevent, reintroduced by the fix for double-ownership.
    const live = makeCache()
    const extracted = makeCache()
    pinToolResult('toolu_live')
    pinToolResult('toolu_extracted')
    live.set('/a.ts', entry('toolu_live'))
    extracted.set('/b.ts', entry('toolu_extracted'))

    const merged = mergeFileStateCaches(live, extracted, { replacesInputs: true })
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
