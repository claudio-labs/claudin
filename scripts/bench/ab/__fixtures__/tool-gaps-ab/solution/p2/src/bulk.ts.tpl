/**
 * POST /items/bulk — import many items in one request.
 *
 * The request body is `{ "items": [{ name, qty, tags }, ...] }`. The rules are
 * in docs/SPEC.md §8 ("Bulk import"). In short:
 *
 *   - a batch holds at most MAX_BULK_ITEMS entries (`batch_too_large`), and
 *     that is decided before any entry is looked at;
 *   - names must be unique, compared trimmed and case-insensitively
 *     (`duplicate_name`);
 *   - every entry is validated like the body of POST /items (`invalid_item`,
 *     with the index of the entry in the message);
 *   - success answers 201 with `{ created: [...] }`, in request order.
 *
 * The supplier imports run by the ordering script are the only caller today.
 */
import type { Item, Store } from './store.ts'
import { ApiError, isPlainObject, nameKey } from './validate.ts'

/** The largest batch the endpoint accepts. */
export const MAX_BULK_ITEMS = 100

/** The parsed envelope of a bulk request. Entries are not validated yet. */
export type BulkRequest = { items: unknown[] }

/** What a successful import answers with. */
export type BulkResult = { created: Item[] }

/**
 * Pulls the entry list out of a parsed body. Anything that is not an object
 * with an `items` array is `invalid_item`, so a client gets the same code
 * whether the envelope or an entry inside it is malformed.
 */
export function readBulkRequest(body: unknown): BulkRequest {
  if (!isPlainObject(body)) {
    throw new ApiError(400, 'invalid_item', 'body must be an object of the form {"items": [...]}')
  }
  const { items } = body
  if (!Array.isArray(items)) {
    throw new ApiError(400, 'invalid_item', '"items" must be an array')
  }
  return { items }
}

/**
 * Refuses oversized batches before any entry is examined, so a client that
 * sends ten thousand rows gets a cheap answer.
 */
export function checkBatchSize(items: unknown[]): void {
  if (items.length > MAX_BULK_ITEMS) {
    throw new ApiError(
      400,
      'batch_too_large',
      `a batch holds at most ${MAX_BULK_ITEMS} items, got ${items.length}`,
    )
  }
}

/** The name of an entry, when it has a usable one; validation reports the rest. */
function entryName(entry: unknown): string | undefined {
  if (!isPlainObject(entry)) return undefined
  const { name } = entry
  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

/**
 * Names must not clash, compared with nameKey(), neither with the store nor
 * with an earlier entry of the same batch.
 */
export function checkDuplicateNames(store: Store, items: unknown[]): void {
  const taken = new Map<string, string>()
  for (const item of store.list()) taken.set(nameKey(item.name), item.id)

  items.forEach((entry, index) => {
    const name = entryName(entry)
    if (name === undefined) return
    const owner = taken.get(nameKey(name))
    if (owner !== undefined) {
      throw new ApiError(
        400,
        'duplicate_name',
        `items[${index}]: name "${name.trim()}" is already used by ${owner}`,
      )
    }
    taken.set(nameKey(name), `items[${index}]`)
  })
}

/**
 * Runs the whole import: envelope, size, names, then creation. Creation goes
 * through Store.createMany, which validates each entry like POST /items.
 */
export function importBulk(store: Store, body: unknown): BulkResult {
  const { items } = readBulkRequest(body)
  checkBatchSize(items)
  checkDuplicateNames(store, items)
  return { created: store.createMany(items) }
}

/** One log line describing a finished import, for server.log. */
export function describeImport(result: BulkResult): string {
  const count = result.created.length
  if (count === 0) return 'bulk import: nothing to create'
  const first = result.created[0]!.id
  const last = result.created[count - 1]!.id
  return `bulk import: created ${count} item${count === 1 ? '' : 's'} (${first}..${last})`
}
