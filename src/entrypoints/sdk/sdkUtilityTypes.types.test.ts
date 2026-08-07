/**
 * Type-level tests for `NonNullableUsage` (src/entrypoints/sdk/sdkUtilityTypes.ts).
 *
 * Another reconstructed module, and one whose two deviations from a plain
 * mapping of the SDK's `BetaUsage` — `fallback_credit` dropped, `speed` added
 * — exist only because the two values of the type in this tree happen to
 * supply exactly those eleven fields. Nothing enforced that pairing; it was a
 * comment. If the Anthropic SDK grows a nullable counter, the type silently
 * widens and both literals become incomplete, and the error surfaces at the
 * literals rather than here.
 *
 * The assertions below are deliberately written against properties of the
 * mapping (no null, no undefined, no fallback_credit) rather than against a
 * hardcoded field list, so an SDK bump does not spuriously fail them.
 */
import { expect, test } from 'bun:test'
import type { Equal, Expect, ExpectFalse, HasKey } from '../../types/typeAssertions.js'
import type { NonNullableUsage } from './sdkUtilityTypes.js'
import { EMPTY_USAGE } from '../../services/api/emptyUsage.js'

// --- the two documented deviations from a plain BetaUsage mapping ----------

// Dropped: nothing in src/ reads it, and neither value supplies it, so keeping
// it would make both literals incomplete.
type _NoFallbackCredit = ExpectFalse<HasKey<NonNullableUsage, 'fallback_credit'>>

// Added: absent from BetaUsage itself (it lives on the beta message-params
// type), but both values set it.
type _HasSpeed = Expect<HasKey<NonNullableUsage, 'speed'>>
type _Speed = Expect<Equal<NonNullableUsage['speed'], 'standard' | 'fast'>>

// --- the mapping's whole purpose: nothing is nullable or optional ----------

// `-?` strips optionality and `NonNullable<...>` strips null, so that every
// accumulator downstream (cost math, context-window readout, transcript
// footer) can treat these as numbers without re-checking.
type _NotNull = ExpectFalse<null extends NonNullableUsage['input_tokens'] ? true : false>
type _NotUndef = ExpectFalse<
  undefined extends NonNullableUsage['input_tokens'] ? true : false
>
type _NotNullCacheRead = ExpectFalse<
  null extends NonNullableUsage['cache_read_input_tokens'] ? true : false
>
type _NotUndefOutput = ExpectFalse<
  undefined extends NonNullableUsage['output_tokens'] ? true : false
>

// --- the runtime half ------------------------------------------------------

test('EMPTY_USAGE supplies every field of NonNullableUsage, none of them null', () => {
  const keys = Object.keys(EMPTY_USAGE)
  // Eleven is the count the type comment pins. It changes only when the SDK's
  // usage shape does, and then deliberately: the type makes an incomplete
  // literal a compile error, so this assertion is here to make the count a
  // decision rather than a surprise.
  expect(keys).toHaveLength(11)
  expect(keys).toContain('speed')
  expect(keys).not.toContain('fallback_credit')
  for (const [key, value] of Object.entries(EMPTY_USAGE)) {
    expect(value, `${key} must not be null`).not.toBeNull()
    expect(value, `${key} must not be undefined`).not.toBeUndefined()
  }
})
