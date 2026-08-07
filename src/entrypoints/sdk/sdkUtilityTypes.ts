// SDK utility types — the handful of public types that cannot be expressed as
// a Zod schema, so they are not part of the generated coreTypes.generated.ts.
//
// Reconstructed module: the original was not carried into this fork, but
// coreTypes.ts re-exports from it and both services/api/emptyUsage.ts and
// services/api/logging.ts import from it directly.

import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

/**
 * `BetaUsage` with every nullable field narrowed to its non-null form.
 *
 * The API returns `null` for counters that did not apply to a request, but
 * everything downstream (cost math, the context-window readout, the transcript
 * footer) accumulates them as numbers. Usage objects are normalized once on the
 * way in — see `EMPTY_USAGE` in services/api/emptyUsage.ts — and carry this
 * type from then on, so no accumulator has to re-check for null.
 *
 * It is a mapped type over the *beta* usage shape rather than `Usage` because
 * the fields Claudin reads include `iterations` (context-window size) and
 * `speed` (fast-mode cost tier), which only exist there.
 *
 * Two deviations from a plain mapping, both pinned by the only two values of
 * this type in the tree — `EMPTY_USAGE` (services/api/emptyUsage.ts) and the
 * literal `accumulateUsage` returns (services/api/claude/streaming.ts). Each
 * supplies exactly eleven fields:
 *
 *   - `fallback_credit` is dropped. Neither value supplies it, and nothing in
 *     `src/` reads it, so keeping it would make both literals incomplete.
 *   - `speed` is added. It is absent from `BetaUsage` itself (it lives on the
 *     beta message-params type), but both values set it.
 */
export type NonNullableUsage = {
  [K in keyof Omit<BetaUsage, 'fallback_credit'>]-?: NonNullable<BetaUsage[K]>
} & {
  speed: 'standard' | 'fast'
}
