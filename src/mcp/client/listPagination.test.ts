import { describe, expect, test } from 'bun:test'
import { collectListPages, MAX_LIST_PAGES, pageParams } from 'src/mcp/client/listPagination.js'

describe('collectListPages', () => {
  test('a result without nextCursor is the only page', async () => {
    const cursors: Array<string | undefined> = []
    const items = await collectListPages(async cursor => {
      cursors.push(cursor)
      return { items: ['a', 'b'] }
    })
    expect(items).toEqual(['a', 'b'])
    expect(cursors).toEqual([undefined])
  })

  test('follows nextCursor until a page has none, in order', async () => {
    const pages: Record<string, { items: string[]; nextCursor?: string }> = {
      start: { items: ['a'], nextCursor: 'p2' },
      p2: { items: ['b'], nextCursor: 'p3' },
      p3: { items: ['c'] },
    }
    const items = await collectListPages(async cursor => pages[cursor ?? 'start']!)
    expect(items).toEqual(['a', 'b', 'c'])
  })

  test('a page with no items adds nothing but still pages on', async () => {
    const items = await collectListPages<string>(async cursor =>
      cursor ? { items: ['b'] } : { items: undefined, nextCursor: 'p2' },
    )
    expect(items).toEqual(['b'])
  })

  test('stops at a cursor it has already followed', async () => {
    let calls = 0
    const items = await collectListPages(async () => {
      calls++
      return { items: ['x'], nextCursor: 'same' }
    })
    expect(calls).toBe(2)
    expect(items).toEqual(['x', 'x'])
  })

  test('stops after the page limit', async () => {
    let n = 0
    const items = await collectListPages(async () => ({ items: [n], nextCursor: `c${++n}` }), 3)
    expect(items).toEqual([0, 1, 2])
    expect(MAX_LIST_PAGES).toBe(100)
  })

  test('an error on a page is the caller’s to handle', async () => {
    await expect(
      collectListPages(async cursor => {
        if (cursor) throw new Error('page 2 failed')
        return { items: ['a'], nextCursor: 'p2' }
      }),
    ).rejects.toThrow('page 2 failed')
  })
})

describe('pageParams', () => {
  test('the first page sends no params, later pages send the cursor', () => {
    expect(pageParams(undefined)).toEqual({})
    expect(pageParams('p2')).toEqual({ params: { cursor: 'p2' } })
  })
})
