/**
 * Ends a listing whose server hands back a cursor it already gave.
 *
 * MCP list methods page with an opaque cursor, and a server that repeats one
 * (a→b→a) never stops paging. The SDK's list*() stops only on a page that
 * repeats both its cursor and its items, and otherwise throws after 64 pages,
 * so the server lost the whole list. Here a repeated `nextCursor` is deleted
 * from the result before the SDK reads it: the listing ends with the entries
 * it already had, as Claudin's own pager did before the SDK took over.
 *
 * A request with no cursor starts a listing; a request carrying a cursor
 * continues the listing that cursor came from. Listings are told apart by
 * the cursor handed from one page to the next, so two listings of one method
 * in flight on one connection keep separate records.
 */

type RequestId = string | number
type Listing = Set<string>

/** Cursors handed out but not yet sent back, per method; a few is plenty. */
const MAX_PENDING_PER_CURSOR = 4

export type CursorCycleGuard = {
  /** Notes which listing a request belongs to. */
  onRequest: (id: RequestId, method: string, cursor: unknown) => void
  /**
   * Reads the result of a request noted by onRequest. A repeated `nextCursor`
   * is deleted from `result` and returned; anything else returns undefined.
   */
  onResult: (id: RequestId, method: string, result: Record<string, unknown>) => string | undefined
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
        byRequest.set(id, new Set())
        return
      }
      const waiting = handedOut.get(key(method, cursor))
      const listing = waiting?.pop()
      if (waiting && waiting.length === 0) handedOut.delete(key(method, cursor))
      // A cursor this connection never handed out (a caller paging by hand)
      // starts a record of its own.
      byRequest.set(id, listing ?? new Set([cursor]))
    },
    onResult(id, method, result) {
      const listing = byRequest.get(id)
      byRequest.delete(id)
      const next = result.nextCursor
      if (listing === undefined || typeof next !== 'string') return undefined
      if (listing.has(next)) {
        delete result.nextCursor
        return next
      }
      listing.add(next)
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
