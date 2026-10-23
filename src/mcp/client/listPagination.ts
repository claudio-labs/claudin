// MCP list methods page with an opaque cursor: a result carrying `nextCursor`
// has more, and the next request sends it back. A server that repeats a cursor
// it already gave, or never stops paging, is cut off instead of followed.
export const MAX_LIST_PAGES = 100

export type ListPage<T> = { items: T[] | undefined; nextCursor?: string }

export async function collectListPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<ListPage<T>>,
  maxPages = MAX_LIST_PAGES,
): Promise<T[]> {
  const items: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor)
    if (result.items) items.push(...result.items)
    if (!result.nextCursor || seen.has(result.nextCursor)) break
    seen.add(result.nextCursor)
    cursor = result.nextCursor
  }
  return items
}

/** The request params for one page: none on the first, so it is sent as before. */
export function pageParams(cursor: string | undefined): { params?: { cursor: string } } {
  return cursor ? { params: { cursor } } : {}
}
