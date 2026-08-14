import { beforeEach, describe, expect, test } from 'bun:test'
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  type FileState,
} from 'src/utils/fs/fileStateCache.js'
import {
  _resetAllClippedIdsForTesting,
  isPinRegistered,
  pinToolResult,
} from 'src/services/compact/stableStubState.js'
import { installLiveReadFileCache } from './readFileCacheHandover.js'

/**
 * Coverage for headless's read-file-cache handover, which had none — there is
 * no test file for runHeadless.ts at all, and this logic lived inside a closure
 * there. An audit deleted the ownership transfer and the entire suite stayed
 * green, which is exactly the class of bug that made `mergeReplacingLiveCache`
 * a named function instead of an optional boolean.
 */
describe('installLiveReadFileCache', () => {
  const state = (content: string, timestamp: number): FileState => ({
    content,
    timestamp,
    offset: undefined,
    limit: undefined,
  })

  const pinned = (toolUseId: string): FileState => ({
    ...state('x', 1),
    toolUseId,
  })

  const makeCache = () => createFileStateCacheWithSizeLimit(10, 1024 * 1024)

  beforeEach(() => {
    _resetAllClippedIdsForTesting()
  })

  test("the surviving cache inherits the live cache's pins", () => {
    const live = makeCache()
    pinToolResult('toolu_headless')
    live.set('/a.ts', pinned('toolu_headless'))
    const seeds = makeCache()

    // The shape headless actually produces: a transient merge that holds the
    // entry (via `load`) but owns nothing.
    const merged = mergeFileStateCaches(live, seeds)
    const next = installLiveReadFileCache(live, merged, seeds)
    expect(next).toBe(merged)

    // Ownership MOVED rather than being copied — the discarded cache cannot
    // release a pin the survivor now vouches for.
    live.clear()
    expect(isPinRegistered('toolu_headless')).toBe(true)

    // …and the survivor can, which is the whole point. Without the transfer
    // this stays pinned forever: nothing else is entitled to release it, and
    // a leaked pin freezes the clip frontier at its block for the rest of the
    // session.
    next.delete('/a.ts')
    expect(isPinRegistered('toolu_headless')).toBe(false)
  })

  test('a seed never clobbers a newer entry in the incoming cache', () => {
    const live = makeCache()
    const seeds = makeCache()
    seeds.set('/fresh.ts', state('client-observed', 100))
    seeds.set('/gap.ts', state('seeded', 100))

    const incoming = makeCache()
    incoming.set('/fresh.ts', state('read-this-session', 200))

    const next = installLiveReadFileCache(live, incoming, seeds)

    // The seed is older evidence: the client reported a Read it observed, this
    // session read the file itself afterwards. Losing that race must leave the
    // newer content in place or Edit gets pointed at pre-edit bytes.
    expect(next.get('/fresh.ts')?.content).toBe('read-this-session')
    // …while a seed with nothing to lose to still fills its gap.
    expect(next.get('/gap.ts')?.content).toBe('seeded')
  })

  test('the seeds are one-shot — the next cycle re-applies nothing', () => {
    const live = makeCache()
    const seeds = makeCache()
    seeds.set('/gap.ts', state('seeded', 100))

    const first = makeCache()
    installLiveReadFileCache(live, first, seeds)
    expect(first.get('/gap.ts')?.content).toBe('seeded')
    expect(seeds.size).toBe(0)

    // A seed that survived the drain would keep resurrecting itself at every
    // clone-replace boundary, outliving the compact that cleared the entry it
    // describes.
    const second = makeCache()
    installLiveReadFileCache(first, second, seeds)
    expect(second.get('/gap.ts')).toBeUndefined()
  })
})
