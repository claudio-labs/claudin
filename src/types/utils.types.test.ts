/**
 * Type-level tests for `src/types/utils.ts`.
 *
 * That module is a RECONSTRUCTION — the original was not carried into this
 * fork, and its shape was inferred from ~15 type-only import sites. The three
 * carve-outs in `DeepImmutable` are each forced by a real call site and are
 * documented only in prose, so a well-meaning simplification (dropping the
 * function passthrough, say, or the Map/Set branch) would compile here and
 * fail far away, at whichever component takes the immutable view. These
 * assertions put the failure back at the definition.
 *
 * Checked by `tsc`, not by the runner: the one `test()` below only pins the
 * runtime half of `Permutations`, which is the half a value can express.
 */
import { expect, test } from 'bun:test'
import type { Equal, Expect } from 'src/types/typeAssertions.js'
import type { DeepImmutable, Permutations } from 'src/types/utils.js'

// --- DeepImmutable: primitives pass through untouched -----------------------

type _Str = Expect<Equal<DeepImmutable<string>, string>>
type _Num = Expect<Equal<DeepImmutable<number>, number>>
type _Bool = Expect<Equal<DeepImmutable<boolean>, boolean>>
type _Null = Expect<Equal<DeepImmutable<null>, null>>
type _Undef = Expect<Equal<DeepImmutable<undefined>, undefined>>

// Branded strings (AgentId and friends in src/types/ids.ts) are `string & {}`,
// so they satisfy the primitive branch and must NOT be mapped over — mapping
// would turn the brand into a readonly property and break assignability from a
// plain branded value.
type BrandedId = string & { readonly __brand: 'AgentId' }
type _Branded = Expect<Equal<DeepImmutable<BrandedId>, BrandedId>>

// --- DeepImmutable: functions pass through ---------------------------------

// Task state carries `unregisterCleanup?: () => void`. Mapping over a
// function's own properties makes a mutable task un-assignable to a
// DeepImmutable<...> prop, which is the bug this branch prevents.
type _Fn = Expect<Equal<DeepImmutable<() => void>, () => void>>
type _FnArgs = Expect<
  Equal<DeepImmutable<(a: string, b: number) => void>, (a: string, b: number) => void>
>

// --- DeepImmutable: collections become their Readonly* counterparts ---------

type _Map = Expect<
  Equal<DeepImmutable<Map<string, number>>, ReadonlyMap<string, number>>
>
type _Set = Expect<Equal<DeepImmutable<Set<string>>, ReadonlySet<string>>>
type _Arr = Expect<Equal<DeepImmutable<string[]>, readonly string[]>>

// Collections recurse into their members.
type _MapDeep = Expect<
  Equal<
    DeepImmutable<Map<string, { a: number }>>,
    ReadonlyMap<string, { readonly a: number }>
  >
>

// --- DeepImmutable: objects gain readonly, recursively ---------------------

type _Obj = Expect<
  Equal<DeepImmutable<{ a: number }>, { readonly a: number }>
>
type _ObjNested = Expect<
  Equal<
    DeepImmutable<{ a: { b: string[] } }>,
    { readonly a: { readonly b: readonly string[] } }
  >
>

// A method on an object still passes through as a function, not as a mapped
// object — the function branch is checked before the object branch.
type _ObjWithFn = Expect<
  Equal<DeepImmutable<{ f: () => void }>, { readonly f: () => void }>
>

// --- DeepImmutable: distributes over unions --------------------------------

// BackgroundTaskState is a union of seven task shapes passed through this type
// as a whole. Distribution is what keeps each arm discriminable afterwards; a
// non-distributive version would collapse them into one mapped object.
type _Union = Expect<
  Equal<
    DeepImmutable<{ a: 1 } | { b: 2 }>,
    { readonly a: 1 } | { readonly b: 2 }
  >
>

// --- Permutations ----------------------------------------------------------

type _PermTwo = Expect<
  Equal<Permutations<'a' | 'b'>, ['a', 'b'] | ['b', 'a']>
>
type _PermOne = Expect<Equal<Permutations<'a'>, ['a']>>
type _PermNever = Expect<Equal<Permutations<never>, []>>

test('Permutations forces an array literal to enumerate its union', () => {
  type Mode = 'edit' | 'view'
  // The `satisfies` is the whole point: drop a member and this stops compiling,
  // which is how NON_EDITABLE_MODES in utils/messageQueueManager.ts stays
  // exhaustive as the union grows.
  const all = ['edit', 'view'] satisfies Permutations<Mode>
  expect([...all].sort()).toEqual(['edit', 'view'])
})
