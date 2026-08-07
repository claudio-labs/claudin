// Reconstructed from its use sites: the original module was not carried into
// this fork, yet ~15 type-only imports reference it. Both exports are
// type-level utilities with no runtime counterpart.

/**
 * Recursively marks every property of `T` as `readonly`.
 *
 * Used to hand React components a view of state they must not mutate —
 * `AppState` is declared as `DeepImmutable<{...}>` in
 * `src/state/AppStateStore.ts`, and the task dialogs take
 * `DeepImmutable<LocalAgentTaskState>` and friends.
 *
 * Three carve-outs, each forced by a real call site:
 *   - Primitives (including branded strings like `AgentId`) pass through, so
 *     the mapped type never recurses into `string`.
 *   - Functions pass through untouched. Task state carries members such as
 *     `unregisterCleanup?: () => void`, and mapping over a function's own
 *     properties would make a mutable task un-assignable to a
 *     `DeepImmutable<...>` prop.
 *   - `Map`/`Set` become their `Readonly*` counterparts rather than having
 *     their methods rewritten.
 *
 * The distribution over unions is deliberate: `BackgroundTaskState` is a union
 * of seven task shapes and is passed through this type as a whole.
 */
export type DeepImmutable<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? T
  : // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    T extends (...args: never[]) => unknown
    ? T
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<DeepImmutable<U>>
        : T extends ReadonlyArray<infer U>
          ? ReadonlyArray<DeepImmutable<U>>
          : T extends object
            ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
            : T

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never

/**
 * Every ordering of the members of union `T`, as a union of tuples.
 *
 * Used with `satisfies` to force an array literal to enumerate a union
 * exhaustively, so adding a member to the union breaks the literal rather than
 * silently leaving it out — see `NON_EDITABLE_MODES` in
 * `src/utils/messageQueueManager.ts`.
 */
export type Permutations<T, U = T> = [T] extends [never]
  ? []
  : T extends unknown
    ? [T, ...Permutations<Exclude<U, T>>]
    : never

export type { UnionToIntersection }
