import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildTool } from './Tool.js'
import type { ToolResult } from './Tool.js'
import { invalidateAll } from './services/tools/toolResultCache.js'

/**
 * Coverage for the tool-result cache wrapper in buildTool — specifically the
 * `bypassResultCache` hook, which had none. It is a pre-lookup escape hatch, so
 * every one of its guarantees is about something NOT happening (no lookup, no
 * store, no thrown hook reaching the caller) and none of them are observable
 * from the tool's own tests.
 *
 * 'Glob' rather than 'Read': both are on the cache whitelist, and using the one
 * FileReadTool.test.ts exercises would couple the two suites through the
 * process-global cache.
 */
describe('buildTool — result cache + bypassResultCache', () => {
  let calls = 0
  let bypass: boolean | (() => never)

  const makeTool = (opts: { hook?: boolean; noResultCache?: boolean } = {}) => {
    const def = {
      name: 'Glob',
      async call(input: { q: string }): Promise<ToolResult<string>> {
        calls++
        return {
          data: `result-${input.q}-${calls}`,
          ...(opts.noResultCache ? { noResultCache: true } : {}),
        }
      },
      ...(opts.hook === false
        ? {}
        : {
            bypassResultCache() {
              if (typeof bypass === 'function') bypass()
              return bypass
            },
          }),
    }
    // buildTool's parameter is structurally `any`; TOOL_DEFAULTS fills the rest.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return buildTool(def as any)
  }

  const prevDisabled = process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE

  beforeEach(() => {
    // The suite otherwise runs with the cache off, which would make every
    // assertion here vacuously pass.
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '0'
    invalidateAll()
    calls = 0
    bypass = false
  })

  afterEach(() => {
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = prevDisabled ?? '1'
    invalidateAll()
  })

  test('hook returning false: the second call is served from cache', async () => {
    const tool = makeTool()
    const first = await tool.call({ q: 'a' }, {})
    const second = await tool.call({ q: 'a' }, {})
    expect(calls).toBe(1)
    expect(second.data).toBe(first.data)
  })

  test('hook returning true: call() runs every time AND stores nothing', async () => {
    const tool = makeTool()
    bypass = true
    await tool.call({ q: 'a' }, {})
    await tool.call({ q: 'a' }, {})
    expect(calls).toBe(2)

    // The "stores nothing" half is the one that matters and the one a naive
    // implementation gets wrong: if a bypassing call had written an entry, the
    // first non-bypassing call would be served from it and `calls` would stay
    // at 2. A bypass must leave the cache exactly as it found it.
    bypass = false
    await tool.call({ q: 'a' }, {})
    expect(calls).toBe(3)
  })

  test('a throwing hook is logged and falls back to ordinary caching', async () => {
    const tool = makeTool()
    bypass = () => {
      throw new Error('hook exploded')
    }
    // The call itself must survive — this wrapper fronts every cacheable tool,
    // and a cache optimisation is never worth failing the user's request over.
    const first = await tool.call({ q: 'a' }, {})
    expect(first.data).toBe('result-a-1')

    // …and it must fall back to caching (the pre-hook behavior), not to
    // permanently bypassing.
    const second = await tool.call({ q: 'a' }, {})
    expect(calls).toBe(1)
    expect(second.data).toBe(first.data)
  })

  test('a tool that declares no hook caches exactly as before', async () => {
    const tool = makeTool({ hook: false })
    await tool.call({ q: 'a' }, {})
    await tool.call({ q: 'a' }, {})
    expect(calls).toBe(1)
  })

  test('noResultCache still suppresses the store, hook or no hook', async () => {
    const tool = makeTool({ noResultCache: true })
    await tool.call({ q: 'a' }, {})
    await tool.call({ q: 'a' }, {})
    expect(calls).toBe(2)
  })

  test('distinct inputs do not collide', async () => {
    const tool = makeTool()
    await tool.call({ q: 'a' }, {})
    await tool.call({ q: 'b' }, {})
    expect(calls).toBe(2)
  })
})
