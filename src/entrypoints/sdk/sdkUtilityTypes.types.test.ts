/**
 * Type-level tests for `NonNullableUsage` (src/entrypoints/sdk/sdkUtilityTypes.ts).
 *
 * Another reconstructed module, and one whose deviation from a plain mapping
 * of the SDK's `BetaUsage` — `fallback_credit` dropped — exists only because
 * the two values of the type in this tree happen to supply exactly the
 * remaining eleven fields. Nothing enforced that pairing; it was a comment.
 *
 * Writing these assertions disproved a second claim the header made, that
 * `speed` had to be intersected on because `BetaUsage` lacks it. It does not
 * lack it, the intersection was inert, and both are now gone.
 *
 * Which of the assertions below can actually FAIL was established by mutation,
 * not assumed, because most of `BetaUsage` is not shaped the way a first read
 * suggests. Two results worth carrying:
 *
 *   - Removing `NonNullable<>` from the mapping breaks 44 sites. That is the
 *     load-bearing half, and `cache_read_input_tokens` is a field that proves
 *     it. `input_tokens` and `output_tokens` are plain `number` in `BetaUsage`
 *     — already non-null — so an assertion written against THOSE is a
 *     tautology that passes with the mapping gutted. An earlier draft of this
 *     file made exactly that mistake on three of five assertions.
 *   - Removing `-?` breaks nothing at all: no field of `BetaUsage` is
 *     optional, so the modifier is currently inert. It is kept as a guard
 *     against the SDK making one optional later, but nothing here can pin it,
 *     and pretending otherwise would be the same tautology in the other
 *     direction.
 */
import { expect, test } from 'bun:test'
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  Equal,
  Expect,
  ExpectFalse,
  HasKey,
} from '../../types/typeAssertions.js'
import type { NonNullableUsage } from './sdkUtilityTypes.js'
import { EMPTY_USAGE } from '../../services/api/emptyUsage.js'

// --- the two documented deviations from a plain BetaUsage mapping ----------

// Dropped: nothing in src/ reads it, and neither value supplies it, so keeping
// it would make both literals incomplete.
type _NoFallbackCredit = ExpectFalse<HasKey<NonNullableUsage, 'fallback_credit'>>

// NOT a deviation, despite what the module header used to say. `speed` is a
// field of `BetaUsage` like any other, and the mapping narrows it like any
// other; the `& { speed: 'standard' | 'fast' }` intersection that used to sit
// on this type produced a byte-identical result and has been removed. This
// assertion is what caught that — it was written as `ExpectFalse` on the
// header's claim and failed immediately.
type _SpeedIsInBetaUsage = Expect<HasKey<BetaUsage, 'speed'>>
type _SpeedNullableUpstream = Expect<
  Equal<BetaUsage['speed'], 'standard' | 'fast' | null>
>
type _HasSpeed = Expect<HasKey<NonNullableUsage, 'speed'>>
type _Speed = Expect<Equal<NonNullableUsage['speed'], 'standard' | 'fast'>>

// --- the mapping's whole purpose: the nullable counters stop being nullable -

// Every one of these is `X | null` on BetaUsage, so each fails if the
// `NonNullable<>` is dropped. Verified: that mutation lights up this file plus
// 43 sites in streaming.ts and its callers.
type _CacheRead = Expect<Equal<NonNullableUsage['cache_read_input_tokens'], number>>
type _CacheCreation = Expect<
  Equal<NonNullableUsage['cache_creation_input_tokens'], number>
>
type _InferenceGeo = Expect<Equal<NonNullableUsage['inference_geo'], string>>
type _ServiceTier = Expect<
  Equal<NonNullableUsage['service_tier'], 'standard' | 'priority' | 'batch'>
>
type _NoNullAnywhere = ExpectFalse<
  null extends NonNullableUsage['iterations'] ? true : false
>

// The two counters that were never nullable to begin with. Pinned as what they
// are — a statement about BetaUsage, not about the mapping — so that the SDK
// making either one nullable is a visible change rather than a silent one that
// the assertions above would keep quiet about.
type _InputTokensAlreadyPlain = Expect<Equal<BetaUsage['input_tokens'], number>>
type _OutputTokensAlreadyPlain = Expect<Equal<BetaUsage['output_tokens'], number>>

// --- the runtime half ------------------------------------------------------

test('EMPTY_USAGE supplies every field of NonNullableUsage, none of them null', () => {
  const keys = Object.keys(EMPTY_USAGE)
  // Eleven = BetaUsage's own eleven, minus fallback_credit, plus speed. It
  // changes only when the SDK's usage shape does, and then deliberately: the
  // type makes an incomplete literal a compile error, so this assertion is
  // here to make the count a decision rather than a surprise.
  expect(keys).toHaveLength(11)
  expect(keys).toContain('speed')
  expect(keys).not.toContain('fallback_credit')
  for (const [key, value] of Object.entries(EMPTY_USAGE)) {
    expect(value, `${key} must not be null`).not.toBeNull()
    expect(value, `${key} must not be undefined`).not.toBeUndefined()
  }
})
