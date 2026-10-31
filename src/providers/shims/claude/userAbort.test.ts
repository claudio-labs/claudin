import { APIUserAbortError } from '@anthropic-ai/sdk'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isUserAbort } from 'src/providers/shims/claude/userAbort.js'

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

describe('isUserAbort', () => {
  test('the SDK abort counts on its own', () => {
    expect(isUserAbort(new APIUserAbortError(), new AbortController().signal)).toBe(true)
  })

  test('the openai shim rethrows fetch\'s DOMException; with the signal aborted it is the user', () => {
    const error = new DOMException('The operation was aborted.', 'AbortError')
    expect(isUserAbort(error, abortedSignal())).toBe(true)
  })

  test('an AbortError while the signal is live is not the user (a timeout, a dropped socket)', () => {
    const error = new DOMException('The operation was aborted.', 'AbortError')
    expect(isUserAbort(error, new AbortController().signal)).toBe(false)
  })

  test('any other error is not an abort, aborted signal or not', () => {
    expect(isUserAbort(new Error('boom'), abortedSignal())).toBe(false)
    expect(isUserAbort(new Error('boom'), new AbortController().signal)).toBe(false)
  })
})

// queryModel's generator does not run under bun test, so the wiring is pinned
// on the source: both terminal error handlers must return silently on Esc
// instead of yielding "API Error: The operation was aborted."
describe('streaming.ts wiring', () => {
  const source = readFileSync(join(import.meta.dir, 'streaming.ts'), 'utf8')

  test('both terminal handlers ask isUserAbort with the request signal', () => {
    expect(source.match(/if \(isUserAbort\(error, signal\)\) \{/g)?.length).toBe(2)
  })

  test('no terminal handler still asks only for the SDK abort class', () => {
    expect(source).not.toContain('if (isSdkApiUserAbortError(error)) {')
  })
})
