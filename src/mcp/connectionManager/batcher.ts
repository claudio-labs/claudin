export type Batcher<T> = {
  push: (item: T) => void
  /** Applies whatever is queued now. */
  flush: () => void
  /** Flushes, then drops anything pushed later. */
  dispose: () => void
}

/** Items pushed within `windowMs` of the first queued one are applied together. */
export function createBatcher<T>(apply: (items: T[]) => void, windowMs = 16): Batcher<T> {
  let queued: T[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (queued.length === 0) return
    const items = queued
    queued = []
    apply(items)
  }

  return {
    push: item => {
      if (disposed) return
      queued.push(item)
      timer ??= setTimeout(flush, windowMs)
    },
    flush,
    dispose: () => {
      flush()
      disposed = true
    },
  }
}
