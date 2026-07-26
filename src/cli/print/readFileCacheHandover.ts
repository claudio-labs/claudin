import type { FileStateCache } from 'src/utils/fileStateCache.js'

/**
 * Install `incoming` as the session's live read-file cache and drain
 * `pendingSeeds` into it. Returns the cache the caller should keep.
 *
 * Extracted from runHeadless's `setReadFileCache` closure because the first
 * line is an invariant an audit found nothing could catch: it lived inside a
 * closure in a 3k-line module with no test file, and deleting it left the
 * whole suite green.
 *
 * `mergeFileStateCaches` deliberately owns no pins — its result is normally a
 * transient view of two caches that both stay live, and a second owner of one
 * tool_use id means whichever cache disposes first releases a pin the other
 * still vouches for. But headless promotes that result OVER the live cache, so
 * without moving ownership across, every pin the live cache held is stranded:
 * `LRUCache.dispose` does not run on GC, so from that point no pin in the
 * session can be released early and the prompt cache's clip frontier freezes
 * at the first pinned block for the rest of the run. None of that is visible
 * at runtime, which is why it needs a test rather than a reviewer.
 *
 * `transferOwnershipFrom` no-ops when the donor IS the survivor, which is the
 * shape the getter hands back whenever there are no seeds to merge — so this
 * takes no `incoming !== live` guard. A guard there would be a line no test
 * could ever turn red.
 */
export function installLiveReadFileCache(
  live: FileStateCache,
  incoming: FileStateCache,
  pendingSeeds: FileStateCache,
): FileStateCache {
  incoming.transferOwnershipFrom(live)
  for (const [path, seed] of pendingSeeds.entries()) {
    const existing = incoming.get(path)
    // Live entries win ties. A seed describes a Read the CLIENT observed and
    // reported after the fact, so it is older evidence than anything this
    // session read for itself; overwriting with it would point Edit at
    // pre-edit content.
    if (!existing || seed.timestamp > existing.timestamp) {
      incoming.set(path, seed)
    }
  }
  // One-shot: each seed survives exactly this clone-replace cycle and then is
  // an ordinary entry, subject to compact's clear like everything else.
  pendingSeeds.clear()
  return incoming
}
