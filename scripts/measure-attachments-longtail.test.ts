import { describe, expect, test } from 'bun:test'

import { measureLongtailAttachments } from './measure-attachments-longtail.ts'

describe('measureLongtailAttachments', () => {
  test('produces 4 kinds × 4 counts × 3 body sizes = 48 rows by default', async () => {
    const result = await measureLongtailAttachments()
    expect(result.rows).toHaveLength(48)
  })

  test('within each (kind, body), bytes grow monotonically with count', async () => {
    const result = await measureLongtailAttachments({ counts: [1, 10, 50, 200] })
    const groups = new Map<string, typeof result.rows>()
    for (const r of result.rows) {
      const key = `${r.kind}|${r.bodyBytes}`
      const list = groups.get(key) ?? []
      list.push(r)
      groups.set(key, list)
    }
    for (const [, rows] of groups) {
      const sorted = rows.sort((a, b) => a.count - b.count)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.bytes).toBeGreaterThanOrEqual(sorted[i - 1]!.bytes)
      }
    }
  })

  test('slopes are reported per (kind, body) combination', async () => {
    const result = await measureLongtailAttachments()
    expect(result.slopesPerEntry.length).toBe(12) // 4 kinds × 3 bodies
    for (const s of result.slopesPerEntry) {
      expect(s.bytesPerEntry).toBeGreaterThan(0)
      expect(s.tokensPerEntry).toBeGreaterThan(0)
    }
  })

  test('larger body sizes yield steeper slopes for body-bearing deltas', async () => {
    const result = await measureLongtailAttachments({
      bodyBytes: [100, 3000],
      counts: [1, 50],
    })
    // For memory_delta (body-bearing), bigger body → bigger slope.
    const memSmall = result.slopesPerEntry.find(
      s => s.kind === 'memory_delta' && s.bodyBytes === 100,
    )!
    const memLarge = result.slopesPerEntry.find(
      s => s.kind === 'memory_delta' && s.bodyBytes === 3000,
    )!
    expect(memLarge.bytesPerEntry).toBeGreaterThan(memSmall.bytesPerEntry * 5)
  })

  test('mcp_instructions_delta has higher slope than agent_listing_delta at same body size', async () => {
    const result = await measureLongtailAttachments({ bodyBytes: [800] })
    const mcp = result.slopesPerEntry.find(
      s => s.kind === 'mcp_instructions_delta' && s.bodyBytes === 800,
    )!
    const agents = result.slopesPerEntry.find(
      s => s.kind === 'agent_listing_delta' && s.bodyBytes === 800,
    )!
    expect(mcp.bytesPerEntry).toBeGreaterThan(agents.bytesPerEntry)
  })

  test('count=0 sweeps cleanly', async () => {
    const result = await measureLongtailAttachments({
      counts: [0],
      bodyBytes: [100],
    })
    expect(result.rows.length).toBe(4)
    for (const r of result.rows) {
      expect(r.bytes).toBeGreaterThanOrEqual(0)
    }
  })
})
