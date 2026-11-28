import { afterEach, describe, expect, test } from 'bun:test'
import {
  contentHash,
  dueLists,
  getListRecord,
  getListRecords,
  LIST_TTL_FLOOR_MS,
  LIST_TTL_MAX_BACKOFF_MS,
  listKey,
  type ListTtlRecord,
  markListRefreshFailed,
  newListRecord,
  nextRefreshAt,
  readTtlMs,
  recordListFetch,
  resetListTtlRecordsForTests,
  revertListRecord,
  withFailedRefresh,
} from 'src/mcp/client/listTtl.js'

afterEach(() => {
  resetListTtlRecordsForTests()
})

const T0 = 1_000_000

describe('readTtlMs', () => {
  test('takes a positive safe integer', () => {
    expect(readTtlMs({ ttlMs: 90_000 })).toBe(90_000)
  })

  test('reads anything else as 0, the spec default', () => {
    expect(readTtlMs({ ttlMs: 0 })).toBe(0)
    expect(readTtlMs({ ttlMs: -5 })).toBe(0)
    expect(readTtlMs({ ttlMs: 1.5 })).toBe(0)
    expect(readTtlMs({ ttlMs: '60000' })).toBe(0)
    expect(readTtlMs({ ttlMs: Number.MAX_SAFE_INTEGER + 2 })).toBe(0)
    expect(readTtlMs({})).toBe(0)
    expect(readTtlMs(null)).toBe(0)
    expect(readTtlMs('ttlMs')).toBe(0)
  })
})

describe('contentHash', () => {
  test('ignores key order and follows the content', () => {
    const a = [{ name: 't', description: 'd', inputSchema: { type: 'object' } }]
    const reordered = [{ inputSchema: { type: 'object' }, description: 'd', name: 't' }]
    expect(contentHash(a)).toBe(contentHash(reordered))
    expect(contentHash(a)).not.toBe(contentHash([{ ...a[0], description: 'other' }]))
    expect(contentHash(a)).not.toBe(contentHash([...a, ...a]))
  })
})

describe('newListRecord', () => {
  test('draws the jitter once, as a fraction of the interval', () => {
    expect(newListRecord(300_000, 'h', T0, 0.5)).toEqual({
      ttlMs: 300_000,
      fetchedAt: T0,
      hash: 'h',
      jitterMs: 15_000,
      failures: 0,
      failedAt: 0,
    })
  })

  test('a TTL under the floor jitters over the floor', () => {
    expect(newListRecord(1_000, 'h', T0, 0.5).jitterMs).toBe(3_000)
    expect(newListRecord(0, 'h', T0, 0.25).jitterMs).toBe(1_500)
  })
})

describe('nextRefreshAt', () => {
  test('a list without a TTL is never due', () => {
    expect(nextRefreshAt(newListRecord(0, 'h', T0, 0))).toBe(Infinity)
  })

  test('a TTL under the floor waits the floor', () => {
    expect(nextRefreshAt(newListRecord(1_000, 'h', T0, 0))).toBe(T0 + LIST_TTL_FLOOR_MS)
  })

  test('a TTL over the floor waits the TTL plus the jitter', () => {
    expect(nextRefreshAt(newListRecord(300_000, 'h', T0, 0.5))).toBe(T0 + 300_000 + 15_000)
  })

  test('failed refreshes back off from the last failure, doubling up to an hour', () => {
    const fresh = newListRecord(1_000, 'h', T0, 0)
    const due = T0 + LIST_TTL_FLOOR_MS
    const once = withFailedRefresh(fresh, due)
    expect(once).toMatchObject({ failures: 1, failedAt: due })
    expect(nextRefreshAt(once)).toBe(due + LIST_TTL_FLOOR_MS)
    const twice = withFailedRefresh(once, due + LIST_TTL_FLOOR_MS)
    expect(nextRefreshAt(twice)).toBe(due + 3 * LIST_TTL_FLOOR_MS)
    let many: ListTtlRecord = twice
    for (let i = 0; i < 20; i++) many = withFailedRefresh(many, due)
    expect(nextRefreshAt(many)).toBe(due + LIST_TTL_MAX_BACKOFF_MS)
  })

  test('a backoff never brings the refresh before the TTL', () => {
    const long = withFailedRefresh(newListRecord(3_600_000, 'h', T0, 0), T0 + 1)
    expect(nextRefreshAt(long)).toBe(T0 + 3_600_000)
  })
})

describe('dueLists', () => {
  const records = new Map<string, ListTtlRecord>([
    [listKey('a', 'tools'), newListRecord(1_000, 'h', T0, 0)],
    [listKey('a', 'prompts'), newListRecord(0, 'h', T0, 0)],
    [listKey('a', 'resources'), newListRecord(1_000, 'h', T0, 0)],
    [listKey('b', 'tools'), newListRecord(1_000, 'h', T0, 0)],
    [listKey('gone', 'tools'), newListRecord(1_000, 'h', T0, 0)],
  ])
  const servers = [
    { name: 'a', listChanged: {} },
    { name: 'b', listChanged: { tools: true } },
    { name: 'c', listChanged: {} },
  ]

  test('nothing is due before the floor', () => {
    expect(dueLists(T0 + LIST_TTL_FLOOR_MS - 1, records, servers)).toEqual([])
  })

  test('only lists with a TTL, of connected servers that do not announce changes', () => {
    expect(dueLists(T0 + LIST_TTL_FLOOR_MS, records, servers)).toEqual([
      { server: 'a', kind: 'tools' },
      { server: 'a', kind: 'resources' },
    ])
  })
})

describe('the records', () => {
  test('a fetch records its TTL and hash, and a later one replaces it', () => {
    recordListFetch('srv', 'tools', { ttlMs: 120_000 }, [{ name: 'x' }], T0, 0)
    const first = getListRecord('srv', 'tools')
    expect(first).toEqual(newListRecord(120_000, contentHash([{ name: 'x' }]), T0, 0))
    expect(getListRecords().get(listKey('srv', 'tools'))).toBe(first!)
    recordListFetch('srv', 'tools', {}, [{ name: 'x' }])
    expect(getListRecord('srv', 'tools')).not.toBe(first!)
    expect(getListRecord('srv', 'tools')?.ttlMs).toBe(0)
  })

  test('a failed refresh is counted on the record it failed to replace', () => {
    recordListFetch('srv', 'prompts', { ttlMs: 1 }, [], T0, 0)
    markListRefreshFailed('srv', 'prompts', T0 + 5)
    expect(getListRecord('srv', 'prompts')).toMatchObject({ failures: 1, failedAt: T0 + 5 })
    markListRefreshFailed('srv', 'resources', T0)
    expect(getListRecord('srv', 'resources')).toBeUndefined()
  })

  test('a revert puts the old record back, unless a later fetch replaced the one it reverts', () => {
    recordListFetch('srv', 'tools', { ttlMs: 1 }, [{ name: 'old' }], T0, 0)
    const previous = getListRecord('srv', 'tools')!
    recordListFetch('srv', 'tools', { ttlMs: 1 }, [{ name: 'new' }], T0 + 1, 0)
    const fetched = getListRecord('srv', 'tools')!
    revertListRecord('srv', 'tools', fetched, previous)
    expect(getListRecord('srv', 'tools')).toBe(previous)

    recordListFetch('srv', 'tools', { ttlMs: 1 }, [{ name: 'new' }], T0 + 2, 0)
    const reconnected = getListRecord('srv', 'tools')!
    revertListRecord('srv', 'tools', fetched, previous)
    expect(getListRecord('srv', 'tools')).toBe(reconnected)
  })
})
