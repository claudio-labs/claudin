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
export type { AnyMessage } from 'src/agent/compact/stableStubState/types.js'
export {
  _getClippedIdsMapSizeForTesting,
  _getClippedIdsTotalCountForTesting,
  _resetAllClippedIdsForTesting,
  addClippedIds,
  bumpStandDownEpoch,
  getClippedIds,
  getStandDownEpoch,
  pruneOrphanClippedIds,
  pruneStaleClippedIds,
  resetClippedIds,
} from 'src/agent/compact/stableStubState/clippedIdRegistry.js'
export {
  MAX_PINNED_RESULT_TOKENS,
  MAX_SHIELDED_PASSES,
  _getPinnedToolResultsForTesting,
  _getSpentPinIdsForTesting,
  exceedsPinnedResultCeiling,
  isPinRegistered,
  isPinShielding,
  pinShieldsBlock,
  pinToolResult,
  retirePinAfterUse,
  unpinToolResult,
} from 'src/agent/compact/stableStubState/pinRegistry.js'
export {
  buildClipStub,
  buildClipStubWithHead,
  isClipStubContent,
  stubToolResultForDisplay,
} from 'src/agent/compact/stableStubState/clipStubText.js'
export type { ClipFrontierMutability } from 'src/agent/compact/stableStubState/clipFrontier.js'
export {
  _resetClipFrontierForTesting,
  collectClearableCandidates,
  getClipFrontierIndex,
  isClipFrontierEnabled,
  pruneContentReplacementState,
  pruneOldToolResults,
} from 'src/agent/compact/stableStubState/clipFrontier.js'
export { applyStableStubs } from 'src/agent/compact/stableStubState/applyStubs.js'
