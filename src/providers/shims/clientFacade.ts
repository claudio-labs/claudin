/**
 * What a client Claudin builds itself (vendorAnthropic/, bedrockConverse/,
 * the tool-search wrapper) needs to stand where an Anthropic SDK client does.
 *
 * - The promise `create` returns: awaited it is the data, and
 *   `withResponse()` is the whole answer, as streaming.ts reads it.
 * - A view of another client with some members replaced: every other member is
 *   the client's own, bound to it, so a capability it has
 *   (`keepAlivePingParams`) or lacks (`countTokens`) reads the same through
 *   the view. A member replaced with `undefined` is gone, for `in` too.
 */
export type ApiResult<D = unknown> = { data: D; [key: string]: unknown }
export type ApiPromise<D = unknown> = Promise<D> & { withResponse: () => Promise<ApiResult<D>> }

/** One answer, read either way. */
export function apiPromise<D>(answered: Promise<ApiResult<D>>): ApiPromise<D> {
  const out = answered.then(result => result.data) as ApiPromise<D>
  // A caller that only takes withResponse() never awaits `out` itself.
  out.catch(() => {})
  out.withResponse = () => answered
  return out
}

/** Another client's promise with its data mapped, read either way as it was. */
export function mapApiPromise<D, E>(inner: ApiPromise<D>, map: (data: D) => E): ApiPromise<E> {
  const out = Promise.resolve(inner).then(map) as ApiPromise<E>
  out.catch(() => {})
  out.withResponse = async () => {
    const result = await inner.withResponse()
    return { ...result, data: map(result.data) }
  }
  return out
}

export function overrideMembers<T extends object>(target: T, overrides: Partial<Record<PropertyKey, unknown>>): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in overrides) return overrides[prop]
      const value = Reflect.get(obj, prop, obj)
      return typeof value === 'function' ? value.bind(obj) : value
    },
    has(obj, prop) {
      return prop in overrides ? overrides[prop] !== undefined : Reflect.has(obj, prop)
    },
  })
}
