import { describe, expect, test } from 'bun:test'

import { resumeOnce } from 'src/tools/SendMessageTool/resumeOnce.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('resumeOnce — two sends to one stopped agent start one run', () => {
  test('the second send joins the run the first is starting', async () => {
    const starting = deferred<string>()
    let runs = 0
    const resume = () => {
      runs++
      return starting.promise
    }
    const first = resumeOnce('a1', resume)
    const second = resumeOnce('a1', resume)
    starting.resolve('out.txt')
    expect(await first).toEqual({ resumed: 'out.txt' })
    expect(await second).toEqual({ joined: true })
    expect(runs).toBe(1)
  })

  test('a failed resume fails the send that joined it too', async () => {
    const starting = deferred<string>()
    const first = resumeOnce('a2', () => starting.promise)
    const second = resumeOnce('a2', () => Promise.resolve('never'))
    // allSettled, not expect().rejects: bun's rejects blocks on a pending
    // promise, so the reject below would never run.
    const settled = Promise.allSettled([first, second])
    starting.reject(new Error('no transcript'))
    const reasons = (await settled).map(result =>
      result.status === 'rejected' ? (result.reason as Error).message : 'resolved',
    )
    expect(reasons).toEqual(['no transcript', 'no transcript'])
  })

  test('once a resume has settled, the next send starts a new one', async () => {
    await resumeOnce('a3', () => Promise.resolve('first'))
    expect(await resumeOnce('a3', () => Promise.resolve('second'))).toEqual({ resumed: 'second' })
  })

  test('different agents do not wait on each other', async () => {
    const slow = deferred<string>()
    const first = resumeOnce('a4', () => slow.promise)
    expect(await resumeOnce('a5', () => Promise.resolve('other'))).toEqual({ resumed: 'other' })
    slow.resolve('done')
    await first
  })
})
