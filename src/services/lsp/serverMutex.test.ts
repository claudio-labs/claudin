import { afterEach, describe, expect, test } from 'bun:test'
import { __resetServerMutexForTests, withServerMutex } from './serverMutex.js'

afterEach(() => {
  __resetServerMutexForTests()
})

function makeDeferred<T = void>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withServerMutex', () => {
  test('serializes concurrent calls for the same server', async () => {
    const events: string[] = []
    const d1 = makeDeferred<void>()
    const d2 = makeDeferred<void>()

    const p1 = withServerMutex('alpha', async () => {
      events.push('start1')
      await d1.promise
      events.push('end1')
    })
    const p2 = withServerMutex('alpha', async () => {
      events.push('start2')
      await d2.promise
      events.push('end2')
    })

    // Yield once — start1 should have run, start2 must NOT have started yet.
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['start1'])

    d1.resolve()
    await p1
    // Let p2's then-chain pick up the released lock
    await new Promise(r => setTimeout(r, 0))
    expect(events).toEqual(['start1', 'end1', 'start2'])

    d2.resolve()
    await p2
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2'])
  })

  test('runs different servers in parallel', async () => {
    const events: string[] = []
    const d1 = makeDeferred<void>()
    const d2 = makeDeferred<void>()
    const p1 = withServerMutex('alpha', async () => {
      events.push('start-alpha')
      await d1.promise
      events.push('end-alpha')
    })
    const p2 = withServerMutex('beta', async () => {
      events.push('start-beta')
      await d2.promise
      events.push('end-beta')
    })
    await Promise.resolve()
    await Promise.resolve()
    // Both started — different keys can run concurrently
    expect(events.sort()).toEqual(['start-alpha', 'start-beta'])
    d1.resolve()
    d2.resolve()
    await Promise.all([p1, p2])
  })

  test('releases the lock even if fn throws', async () => {
    await expect(
      withServerMutex('alpha', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // A subsequent call must not be blocked.
    const result = await withServerMutex('alpha', async () => 'ok')
    expect(result).toBe('ok')
  })

  test('propagates the fn return value', async () => {
    const result = await withServerMutex('alpha', async () => 42)
    expect(result).toBe(42)
  })
})
