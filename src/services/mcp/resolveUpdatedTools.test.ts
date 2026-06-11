/**
 * A1 regression — MCP tool-pool stability for the prompt cache.
 *
 * The tools array is serialized into every request's cached prefix. The old
 * update path rebuilt it as `reject(prefix) + append`, which moved a
 * server's tools to the END of the pool on every client update — so a
 * reconnect with an IDENTICAL tool set still reordered the array (byte
 * change → full cache invalidation). And a transition to 'failed' coerced
 * the server's tools to [], paying a second full break when the server came
 * back. resolveUpdatedTools fixes both: positional replacement and
 * keep-on-failed.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '../../Tool.js'
import { resolveUpdatedTools } from './useManageMCPConnections.js'

type ToolDouble = { name: string; description: string }

function t(name: string, description = `${name} description`): Tool {
  return { name, description } as unknown as Tool
}

const PREFIX = 'mcp__srv1__'

function poolFixture(): Tool[] {
  return [
    t('Bash'),
    t('mcp__srv1__alpha'),
    t('mcp__srv1__beta'),
    t('Read'),
    t('mcp__srv2__gamma'),
  ]
}

function names(tools: Tool[]): string[] {
  return tools.map(x => (x as unknown as ToolDouble).name)
}

describe('resolveUpdatedTools — positional replacement', () => {
  test('identical reconnect: same order, byte-identical serialization, fresh objects', () => {
    const pool = poolFixture()
    const fresh = [t('mcp__srv1__alpha'), t('mcp__srv1__beta')]
    const out = resolveUpdatedTools(pool, 'connected', PREFIX, fresh)

    // Order and serialized bytes are EXACTLY what was already in the pool —
    // zero cache impact for a drop+reconnect cycle.
    expect(names(out)).toEqual(names(pool))
    expect(JSON.stringify(out)).toBe(JSON.stringify(pool))
    // ...but the VALUES are the fresh objects, so calls route to the
    // reconnected client, not the dead one.
    expect(out[1]).toBe(fresh[0]!)
    expect(out[2]).toBe(fresh[1]!)
  })

  test('genuinely new tool is appended at the END; existing keep their positions', () => {
    const pool = poolFixture()
    const out = resolveUpdatedTools(pool, 'connected', PREFIX, [
      t('mcp__srv1__alpha'),
      t('mcp__srv1__beta'),
      t('mcp__srv1__delta'),
    ])
    expect(names(out)).toEqual([
      'Bash',
      'mcp__srv1__alpha',
      'mcp__srv1__beta',
      'Read',
      'mcp__srv2__gamma',
      'mcp__srv1__delta',
    ])
  })

  test('tool the server no longer announces is dropped; the rest keep positions', () => {
    const pool = poolFixture()
    const out = resolveUpdatedTools(pool, 'connected', PREFIX, [
      t('mcp__srv1__beta'),
    ])
    expect(names(out)).toEqual(['Bash', 'mcp__srv1__beta', 'Read', 'mcp__srv2__gamma'])
  })

  test('schema change for an existing tool keeps its position but updates the bytes (legit break)', () => {
    const pool = poolFixture()
    const out = resolveUpdatedTools(pool, 'connected', PREFIX, [
      t('mcp__srv1__alpha', 'NEW schema'),
      t('mcp__srv1__beta'),
    ])
    expect(names(out)).toEqual(names(pool))
    expect((out[1] as unknown as ToolDouble).description).toBe('NEW schema')
  })

  test('other servers and built-ins are never touched', () => {
    const pool = poolFixture()
    const out = resolveUpdatedTools(pool, 'connected', PREFIX, [
      t('mcp__srv1__alpha'),
      t('mcp__srv1__beta'),
    ])
    expect(out[0]).toBe(pool[0]!) // Bash
    expect(out[3]).toBe(pool[3]!) // Read
    expect(out[4]).toBe(pool[4]!) // mcp__srv2__gamma
  })
})

describe('resolveUpdatedTools — failure handling', () => {
  test("'failed' with no payload KEEPS the server's tools (same array reference)", () => {
    const pool = poolFixture()
    const out = resolveUpdatedTools(pool, 'failed', PREFIX, undefined)
    expect(out).toBe(pool)
  })

  test("'disabled' with no payload removes the server's tools (intentional break)", () => {
    const pool = poolFixture()
    const out = resolveUpdatedTools(pool, 'disabled', PREFIX, undefined)
    expect(names(out)).toEqual(['Bash', 'Read', 'mcp__srv2__gamma'])
  })

  test("recovery after 'failed': reconnect update replaces positionally, no reorder", () => {
    const pool = poolFixture()
    const afterFail = resolveUpdatedTools(pool, 'failed', PREFIX, undefined)
    const fresh = [t('mcp__srv1__alpha'), t('mcp__srv1__beta')]
    const afterReconnect = resolveUpdatedTools(
      afterFail,
      'connected',
      PREFIX,
      fresh,
    )
    // Across the whole fail+reconnect cycle the pool serialization never
    // changed — the cached prefix survives the blip end-to-end.
    expect(JSON.stringify(afterReconnect)).toBe(JSON.stringify(pool))
  })

  test("'connected' with undefined payload preserves the pool untouched", () => {
    const pool = poolFixture()
    expect(resolveUpdatedTools(pool, 'connected', PREFIX, undefined)).toBe(pool)
  })
})

// ── Wiring guard ─────────────────────────────────────────────────────────
// resolveUpdatedTools being correct is worthless if the connection hook
// regresses to the old `reject(prefix) + append` rebuild — pin the call
// site so reverting the wiring fails this suite, not just code review.
describe('useManageMCPConnections wiring (source guard)', () => {
  test('the client-update path builds the pool via resolveUpdatedTools', () => {
    const hookSource = readFileSync(
      join(import.meta.dir, 'useManageMCPConnections.ts'),
      'utf8',
    )
    expect(hookSource).toContain('const updatedTools = resolveUpdatedTools(')
  })
})
