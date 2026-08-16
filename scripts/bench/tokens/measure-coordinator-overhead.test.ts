import { describe, expect, test } from 'bun:test'

import { measureCoordinatorOverhead } from './measure-coordinator-overhead.ts'

describe('measureCoordinatorOverhead', () => {
  test('reports four sections with positive token counts', async () => {
    const result = await measureCoordinatorOverhead()
    expect(result.rows).toHaveLength(4)
    const sections = new Set(result.rows.map(r => r.section))
    expect(sections.has('system_prompt')).toBe(true)
    expect(sections.has('user_context')).toBe(true)
    expect(sections.has('worker_tools_listing')).toBe(true)
    expect(sections.has('dispatch_envelope')).toBe(true)
    for (const r of result.rows) {
      expect(r.bytes).toBeGreaterThan(0)
      expect(r.tokens).toBeGreaterThan(0)
    }
  })

  test('coordinator system prompt is non-trivial (>1KB)', async () => {
    const result = await measureCoordinatorOverhead()
    const sys = result.rows.find(r => r.section === 'system_prompt')!
    expect(sys.bytes).toBeGreaterThan(1000)
  })

  test('user context grows with #MCP servers (more names listed)', async () => {
    const a = await measureCoordinatorOverhead({ mcpServers: 0 })
    const b = await measureCoordinatorOverhead({ mcpServers: 10 })
    const aCtx = a.rows.find(r => r.section === 'user_context')!
    const bCtx = b.rows.find(r => r.section === 'user_context')!
    expect(bCtx.bytes).toBeGreaterThan(aCtx.bytes)
  })

  test('projection scales linearly with worker count', async () => {
    const result = await measureCoordinatorOverhead({ workers: [0, 5, 10] })
    const zero = result.projection.find(p => p.workers === 0)!.tokens
    const five = result.projection.find(p => p.workers === 5)!.tokens
    const ten = result.projection.find(p => p.workers === 10)!.tokens
    // (ten - zero) should be exactly 2× (five - zero) — pure linear.
    expect(ten - zero).toBe(2 * (five - zero))
  })

  test('async-allowed tools count is positive (catalog is registered)', async () => {
    const result = await measureCoordinatorOverhead()
    expect(result.asyncAllowedToolCount).toBeGreaterThan(0)
  })
})
