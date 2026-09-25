import { describe, expect, test } from 'bun:test'

import { measureMcpOverhead } from './measure-mcp-overhead.ts'

describe('measureMcpOverhead', () => {
  test('produces a row per server with nonzero bytes', async () => {
    const result = await measureMcpOverhead({
      servers: 3,
      toolsPerServer: 5,
      instructionsBytes: 800,
    })
    expect(result.servers).toHaveLength(3)
    for (const r of result.servers) {
      expect(r.toolSchemasBytes).toBeGreaterThan(0)
      expect(r.instructionsBytes).toBeGreaterThan(0)
      expect(r.totalBytes).toBe(r.toolSchemasBytes + r.instructionsBytes)
    }
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(result.totalTokens).toBeGreaterThan(0)
  })

  test('overhead scales with #servers AND #tools-per-server', async () => {
    const small = await measureMcpOverhead({ servers: 1, toolsPerServer: 3 })
    const moreServers = await measureMcpOverhead({ servers: 4, toolsPerServer: 3 })
    const moreTools = await measureMcpOverhead({ servers: 1, toolsPerServer: 12 })

    expect(moreServers.totalBytes).toBeGreaterThan(small.totalBytes)
    expect(moreTools.totalBytes).toBeGreaterThan(small.totalBytes)
  })

  test('engine choice changes the schema bytes (shim shapes differ)', async () => {
    const anthropic = await measureMcpOverhead({ engine: 'anthropic' })
    const openai = await measureMcpOverhead({ engine: 'openai' })
    const codex = await measureMcpOverhead({ engine: 'codex' })
    const aBytes = anthropic.servers.reduce((acc, r) => acc + r.toolSchemasBytes, 0)
    const oBytes = openai.servers.reduce((acc, r) => acc + r.toolSchemasBytes, 0)
    const cBytes = codex.servers.reduce((acc, r) => acc + r.toolSchemasBytes, 0)
    expect(aBytes).toBeGreaterThan(0)
    expect(oBytes).toBeGreaterThan(0)
    expect(cBytes).toBeGreaterThan(0)
    expect(new Set([aBytes, oBytes, cBytes]).size).toBeGreaterThan(1)
  })

  test('initial-delta attachment ~mirrors the system-prompt instructions block', async () => {
    const result = await measureMcpOverhead({
      servers: 2,
      toolsPerServer: 4,
      instructionsBytes: 1000,
    })
    // The delta wraps the same per-server blocks in a system-reminder shell;
    // expect it to be at least as large as the system-prompt block (chrome
    // text adds bytes) and within a reasonable factor of it.
    expect(result.initialDeltaAttachmentBytes).toBeGreaterThanOrEqual(
      result.systemPromptInstructionsBytes - 200,
    )
    expect(result.initialDeltaAttachmentBytes).toBeLessThan(
      result.systemPromptInstructionsBytes * 1.3,
    )
  })

  test('zero servers → zero overhead', async () => {
    const result = await measureMcpOverhead({ servers: 0 })
    expect(result.servers).toHaveLength(0)
    expect(result.systemPromptInstructionsBytes).toBe(0)
    expect(result.initialDeltaAttachmentBytes).toBe(0)
    expect(result.totalBytes).toBe(0)
    expect(result.totalTokens).toBe(0)
  })
})
