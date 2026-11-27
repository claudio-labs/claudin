import { describe, expect, test } from 'bun:test'
import { createCursorCycleGuard } from 'src/mcp/client/cursorCycleGuard.js'

const M = 'tools/list'

// Drives one page: the request with `cursor`, then a result carrying `next`.
function page(guard: ReturnType<typeof createCursorCycleGuard>, id: number, cursor: string | undefined, next?: string) {
  guard.onRequest(id, M, cursor)
  const result: Record<string, unknown> = next === undefined ? {} : { nextCursor: next }
  const cut = guard.onResult(id, M, result)
  return { repeated: cut, cut, result }
}

describe('createCursorCycleGuard', () => {
  test('a listing that ends on its own is left alone', () => {
    const guard = createCursorCycleGuard()
    expect(page(guard, 1, undefined, 'a').result).toEqual({ nextCursor: 'a' })
    expect(page(guard, 2, 'a', 'b').result).toEqual({ nextCursor: 'b' })
    expect(page(guard, 3, 'b').repeated).toBeUndefined()
  })

  test('a cursor handed back a second time is deleted and reported', () => {
    const guard = createCursorCycleGuard()
    page(guard, 1, undefined, 'a')
    page(guard, 2, 'a', 'b')
    const third = page(guard, 3, 'b', 'a')
    expect(third.repeated).toBe('a')
    expect(third.result).toEqual({})
  })

  test('a page that names its own cursor as the next one is cut', () => {
    const guard = createCursorCycleGuard()
    page(guard, 1, undefined, 'a')
    expect(page(guard, 2, 'a', 'a').repeated).toBe('a')
  })

  test('a cursorless request starts a new listing, so the same cursors pass again', () => {
    const guard = createCursorCycleGuard()
    page(guard, 1, undefined, 'a')
    page(guard, 2, 'a')
    expect(page(guard, 3, undefined, 'a').repeated).toBeUndefined()
    expect(page(guard, 4, 'a', 'b').repeated).toBeUndefined()
  })

  test('two listings of one method in flight keep separate records', () => {
    const guard = createCursorCycleGuard()
    guard.onRequest(1, M, undefined)
    guard.onRequest(2, M, undefined)
    guard.onResult(1, M, { nextCursor: 'a' })
    guard.onResult(2, M, { nextCursor: 'x' })
    guard.onRequest(3, M, 'a')
    guard.onRequest(4, M, 'x')
    expect(guard.onResult(3, M, { nextCursor: 'x' })).toBeUndefined()
    expect(guard.onResult(4, M, { nextCursor: 'a' })).toBeUndefined()
  })

  test('a cursor it never handed out starts a record holding that cursor', () => {
    const guard = createCursorCycleGuard()
    expect(page(guard, 1, 'z', 'z').repeated).toBe('z')
  })

  test('the same cursor on another method belongs to that method’s listing', () => {
    const guard = createCursorCycleGuard()
    page(guard, 1, undefined, 'a')
    guard.onRequest(2, 'prompts/list', undefined)
    expect(guard.onResult(2, 'prompts/list', { nextCursor: 'a' })).toBeUndefined()
  })

  test('an unknown id, a non-string cursor and a forgotten request are ignored', () => {
    const guard = createCursorCycleGuard()
    expect(guard.onResult(9, M, { nextCursor: 'a' })).toBeUndefined()
    guard.onRequest(1, M, undefined)
    expect(guard.onResult(1, M, { nextCursor: 7 })).toBeUndefined()
    guard.onRequest(2, M, undefined)
    guard.forget(2)
    expect(guard.onResult(2, M, { nextCursor: 'a' })).toBeUndefined()
  })

  test('a listing is cut at page 100, with the cursor that page handed out deleted', () => {
    const guard = createCursorCycleGuard()
    page(guard, 1, undefined, 'c2')
    for (let n = 2; n < 100; n++) expect(page(guard, n, `c${n}`, `c${n + 1}`).cut).toBeUndefined()
    const hundredth = page(guard, 100, 'c100', 'c101')
    expect(hundredth.cut).toEqual({ reason: 'pages', pages: 100 })
    expect(hundredth.result).toEqual({})
  })

  test('a page that ends the listing on its own is not cut, whatever its number', () => {
    const guard = createCursorCycleGuard()
    page(guard, 1, undefined, 'c2')
    for (let n = 2; n < 100; n++) page(guard, n, `c${n}`, `c${n + 1}`)
    expect(page(guard, 100, 'c100').cut).toBeUndefined()
  })

  test('the page count is per listing: a new listing starts again at one', () => {
    const guard = createCursorCycleGuard()
    page(guard, 1, undefined, 'c2')
    for (let n = 2; n < 99; n++) page(guard, n, `c${n}`, `c${n + 1}`)
    expect(page(guard, 200, undefined, 'x2').cut).toBeUndefined()
    expect(page(guard, 99, 'c99', 'c100').cut).toBeUndefined()
    expect(page(guard, 201, 'x2', 'x3').cut).toBeUndefined()
  })

  test('keeps only the newest few listings waiting on one cursor', () => {
    const guard = createCursorCycleGuard()
    for (let id = 0; id < 6; id++) page(guard, id, undefined, 'a')
    // The newest waiting listing is taken first; a cycle there is still seen.
    expect(page(guard, 10, 'a', 'a').repeated).toBe('a')
  })
})
