/**
 * When an MCP list is old enough to be asked for again (SEP-2549).
 *
 * On the 2026-07-28 wire every list result carries `ttlMs`, how long it may be
 * used before it is stale. The spec says a client SHOULD NOT poll on it, and
 * MUST add jitter and backoff if it does; Claudin re-reads a list only at the
 * start of a user turn (listTtlRefresh.ts), and only one that:
 *
 * - came with `ttlMs > 0` (0, the default, means what it always did: the list
 *   is read at connect and on list_changed, never on a timer);
 * - belongs to a server that does NOT advertise `listChanged` for it — that
 *   server tells Claudin itself when the list moves;
 * - is at least LIST_TTL_FLOOR_MS old, plus a jitter drawn once per fetch, so
 *   a 1 s TTL still means one request a minute at most;
 * - did not fail its last refresh within the backoff (the floor, doubling per
 *   failure in a row, up to an hour).
 *
 * Each fetch also records a hash of the entries it returned, so a refresh that
 * brings back the same list can leave AppState alone: the tools array is part
 * of the cached prompt prefix (cache.md §5), and a new array with the same
 * tools in it is still a rewrite.
 *
 * In memory only; a new process reads every list at connect anyway.
 */
import { createHash } from 'crypto'
import { stableStringify } from 'src/shared/data/stableStringify.js'

export type McpListKind = 'tools' | 'prompts' | 'resources'

export const MCP_LIST_KINDS: readonly McpListKind[] = ['tools', 'prompts', 'resources']

/** The shortest interval between two TTL reads of one list. */
export const LIST_TTL_FLOOR_MS = 60_000

/** The jitter is up to this fraction of the interval, drawn once per fetch. */
export const LIST_TTL_JITTER_FRACTION = 0.1

/** The longest wait after failed refreshes in a row. */
export const LIST_TTL_MAX_BACKOFF_MS = 60 * 60_000

export type ListTtlRecord = {
  /** The list's `ttlMs`; 0 when it had none, which is never due. */
  readonly ttlMs: number
  readonly fetchedAt: number
  readonly hash: string
  readonly jitterMs: number
  /** Refreshes that failed in a row since this fetch, and when the last one did. */
  readonly failures: number
  readonly failedAt: number
}

/** A connected server, with the lists it announces changes for. */
export type ListTtlServer = {
  readonly name: string
  readonly listChanged: Readonly<Partial<Record<McpListKind, boolean>>>
}

export type DueList = { readonly server: string; readonly kind: McpListKind }

function isValidTtlMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** The `ttlMs` a list result carries, or 0. */
export function readTtlMs(result: unknown): number {
  const ttlMs = typeof result === 'object' && result !== null ? (result as { ttlMs?: unknown }).ttlMs : undefined
  return isValidTtlMs(ttlMs) ? ttlMs : 0
}

/** A hash of the list's entries that ignores key order. */
export function contentHash(entries: unknown): string {
  return createHash('sha256').update(stableStringify(entries)).digest('hex')
}

/** `random` is in [0, 1). */
export function newListRecord(ttlMs: number, hash: string, now: number, random: number): ListTtlRecord {
  const interval = Math.max(ttlMs, LIST_TTL_FLOOR_MS)
  return {
    ttlMs,
    fetchedAt: now,
    hash,
    jitterMs: Math.floor(random * LIST_TTL_JITTER_FRACTION * interval),
    failures: 0,
    failedAt: 0,
  }
}

export function withFailedRefresh(record: ListTtlRecord, now: number): ListTtlRecord {
  return { ...record, failures: record.failures + 1, failedAt: now }
}

/** The earliest time the list may be read again; Infinity for one that has no TTL. */
export function nextRefreshAt(record: ListTtlRecord): number {
  if (record.ttlMs <= 0) return Infinity
  const due = record.fetchedAt + Math.max(record.ttlMs, LIST_TTL_FLOOR_MS) + record.jitterMs
  if (record.failures === 0) return due
  const backoff = Math.min(LIST_TTL_FLOOR_MS * 2 ** (record.failures - 1), LIST_TTL_MAX_BACKOFF_MS)
  return Math.max(due, record.failedAt + backoff)
}

export function listKey(server: string, kind: McpListKind): string {
  return `${server}\u0000${kind}`
}

/** The lists of `servers` to read again at `now`, in server order. */
export function dueLists(
  now: number,
  records: ReadonlyMap<string, ListTtlRecord>,
  servers: readonly ListTtlServer[],
): DueList[] {
  const due: DueList[] = []
  for (const server of servers) {
    for (const kind of MCP_LIST_KINDS) {
      if (server.listChanged[kind]) continue
      const record = records.get(listKey(server.name, kind))
      if (record !== undefined && now >= nextRefreshAt(record)) due.push({ server: server.name, kind })
    }
  }
  return due
}

// --- the process's records ---------------------------------------------------

const records = new Map<string, ListTtlRecord>()

/** Notes a list fetched in full; `entries` is the raw list, before any conversion. */
export function recordListFetch(
  server: string,
  kind: McpListKind,
  result: unknown,
  entries: unknown,
  now: number = Date.now(),
  random: number = Math.random(),
): void {
  records.set(listKey(server, kind), newListRecord(readTtlMs(result), contentHash(entries), now, random))
}

export function getListRecord(server: string, kind: McpListKind): ListTtlRecord | undefined {
  return records.get(listKey(server, kind))
}

export function getListRecords(): ReadonlyMap<string, ListTtlRecord> {
  return records
}

export function markListRefreshFailed(server: string, kind: McpListKind, now: number): void {
  const key = listKey(server, kind)
  const record = records.get(key)
  if (record !== undefined) records.set(key, withFailedRefresh(record, now))
}

/** @internal */
export function resetListTtlRecordsForTests(): void {
  records.clear()
}
