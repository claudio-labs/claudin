// Barrel module for the Anthropic provider client.
//
// The historical monolith (3218 lines) was split into focused submodules
// under ./claude/. This file preserves the public surface so the ~20
// callers across the codebase continue to import from 'src/services/api/claude'.
//
// New code should prefer importing directly from the relevant submodule.
//
// Convention: a few cross-submodule helpers (e.g. `queryModel`,
// `configureEffortParams`, `getPreviousRequestIdFromMessages`,
// `executeNonStreamingRequest`) are `export`ed because their consumer
// lives in a sibling submodule, but they are intentionally NOT
// re-exported here — treat them as package-internal to ./claude/.
//
// Splitting layout:
//   types.ts             — Options, TaskBudgetParam, HaikuOptions, QueryWithModelOptions
//   paramBuilders.ts     — getExtraBodyParams, getPromptCachingEnabled, getCacheControl,
//                          detectLargeSystemPromptOnce, configureEffortParams (internal),
//                          configureTaskBudgetParams, addCacheBreakpoints,
//                          buildSystemPromptBlocks, MAX_NON_STREAMING_TOKENS,
//                          adjustParamsForNonStreaming, getMaxOutputTokensForModel
//   metadata.ts          — getAPIMetadata, verifyApiKey
//   messageConverters.ts — userMessageToMessageParam, assistantMessageToMessageParam,
//                          stripExcessMediaItems,
//                          getPreviousRequestIdFromMessages (internal)
//   nonStreaming.ts      — queryModelWithoutStreaming
//   nonStreamingRequest.ts — executeNonStreamingRequest (used by streaming.ts
//                          fallback path; split out to break a streaming↔nonStreaming cycle)
//   streaming.ts         — queryModel (internal), queryModelWithStreaming,
//                          cleanupStream, updateUsage, accumulateUsage
//   convenience.ts       — queryHaiku, queryWithModel

export {
  accumulateUsage,
  cleanupStream,
  queryModelWithStreaming,
  updateUsage,
} from 'src/providers/shims/claude/streaming.js'

export { queryModelWithoutStreaming } from 'src/providers/shims/claude/nonStreaming.js'

export { getAPIMetadata, verifyApiKey } from 'src/providers/shims/claude/metadata.js'

export {
  assistantMessageToMessageParam,
  stripExcessMediaItems,
  userMessageToMessageParam,
} from 'src/providers/shims/claude/messageConverters.js'

export { getCacheControl } from 'src/providers/shims/claude/cacheControl.js'

export {
  addCacheBreakpoints,
  adjustParamsForNonStreaming,
  buildSystemPromptBlocks,
  configureTaskBudgetParams,
  detectLargeSystemPromptOnce,
  getExtraBodyParams,
  getMaxOutputTokensForModel,
  getPromptCachingEnabled,
  MAX_NON_STREAMING_TOKENS,
} from 'src/providers/shims/claude/paramBuilders.js'

export { queryHaiku, queryWithModel } from 'src/providers/shims/claude/convenience.js'

export type { Options } from 'src/providers/shims/claude/types.js'
