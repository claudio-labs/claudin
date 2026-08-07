/**
 * Compile-time assertion helpers for the `*.types.test.ts` files.
 *
 * These have no runtime counterpart — they are checked by `bun run typecheck`
 * (and therefore by the `typecheck:ci` ratchet, which fails a PR for the
 * diagnostics it ADDS). A broken type invariant shows up there as a new error
 * on the `Expect<...>` line, not as a failing test.
 *
 * `Equal` is the standard conditional-type identity trick: two types are the
 * same only if the two generic function signatures are mutually assignable,
 * which — unlike a bare `X extends Y ? Y extends X` pair — does not collapse
 * `any`, and distinguishes `{a: 1}` from `{readonly a: 1}`.
 */

export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false

/** Fails to compile unless `T` is exactly `true`. */
export type Expect<T extends true> = T

/** Fails to compile unless `T` is exactly `false`. */
export type ExpectFalse<T extends false> = T

/** `true` when `K` is a key of `T`. */
export type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false
