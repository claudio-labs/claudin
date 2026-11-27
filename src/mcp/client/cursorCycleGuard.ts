/**
 * Ends a listing whose server hands back a cursor it already gave, or that
 * is still paging at MAX_LIST_PAGES.
 *
 * MCP list methods page with an opaque cursor, and a server that repeats one
 * (a→b→a) never stops paging. The SDK's list*() stops only on a page that
 * repeats both its cursor and its items, and otherwise throws at its
 * `listMaxPages`, so the server lost the whole list — a long one that does
 * end, too. Here a repeated `nextCursor`, or the one on page MAX_LIST_PAGES,
 * is deleted from the result before the SDK reads it: the listing ends with
 * the entries it already had, as Claudin's own pager did (at the same 100
 * pages) before the SDK took over. Every Client is built with
 * SDK_LIST_MAX_PAGES, above this cap, so the cut here comes first.
 *
 * A request with no cursor starts a listing; a request carrying a cursor
 * continues the listing that cursor came from. Listings are told apart by
 * the cursor handed from one page to the next, so two listings of one method
 * in flight on one connection keep separate records.
 */

type RequestId = string | number
type Listing = { cursors: Set<string>; pages: number }

/** The most pages one listing is followed for. */
export const MAX_LIST_PAGES = 100

/** The `listMaxPages` every Client is built with: past MAX_LIST_PAGES, so it never throws first. */
export const SDK_LIST_MAX_PAGES = MAX_LIST_PAGES + 1

/** Cursors handed out but not yet sent back, per method; a few is plenty. */
const MAX_PENDING_PER_CURSOR = 4

/** Why a listing was cut: a repeated cursor, or MAX_LIST_PAGES pages answered. */
export type ListingCut = { reason: 'cycle'; cursor: string } | { reason: 'pages'; pages: number }

export type CursorCycleGuard = {
  /** Notes which listing a request belongs to. */
  onRequest: (id: RequestId, method: string, cursor: unknown) => void
  /**
   * Reads the result of a request noted by onRequest. A `nextCursor` that ends
   * the listing is deleted from `result`, and the cut returned; anything else
   * returns undefined.
   */
  onResult: (id: RequestId, method: string, result: Record<string, unknown>) => ListingCut | undefined
  /** Drops a request answered with an error. */
  forget: (id: RequestId) => void
}

export function createCursorCycleGuard(): CursorCycleGuard {
  const byRequest = new Map<RequestId, Listing>()
  // `${method}\n${cursor}` → the listings that were handed that cursor,
  // newest last.
  const handedOut = new Map<string, Listing[]>()
  const key = (method: string, cursor: string) => `${method}\n${cursor}`

  return {
    onRequest(id, method, cursor) {
      if (typeof cursor !== 'string') {
        byRequest.set(id, { cursors: new Set(), pages: 0 })
        return
      }
      const waiting = handedOut.get(key(method, cursor))
      const listing = waiting?.pop()
      if (waiting && waiting.length === 0) handedOut.delete(key(method, cursor))
      // A cursor this connection never handed out (a caller paging by hand)
      // starts a record of its own.
      byRequest.set(id, listing ?? { cursors: new Set([cursor]), pages: 0 })
    },
    onResult(id, method, result) {
      const listing = byRequest.get(id)
      byRequest.delete(id)
      if (listing === undefined) return undefined
      listing.pages++
      const next = result.nextCursor
      if (typeof next !== 'string') return undefined
      if (listing.cursors.has(next)) {
        delete result.nextCursor
        return { reason: 'cycle', cursor: next }
      }
      if (listing.pages >= MAX_LIST_PAGES) {
        delete result.nextCursor
        return { reason: 'pages', pages: listing.pages }
      }
      listing.cursors.add(next)
      const waiting = handedOut.get(key(method, next)) ?? []
      waiting.push(listing)
      if (waiting.length > MAX_PENDING_PER_CURSOR) waiting.shift()
      handedOut.set(key(method, next), waiting)
      return undefined
    },
    forget(id) {
      byRequest.delete(id)
    },
  }
}
