// runTurnLoop drives ask() and a whole stream-json session, which no unit
// test can run without a model; the refresh itself is tested in
// src/mcp/listTtlRefresh.test.ts. What is pinned here, on the source, is that
// each headless turn waits for it before the turn's tools are read from the
// store, as the REPL's does (useOnQuery.wiring.test.ts): a stream-json or SDK
// session is many turns, and its lists went stale past their TTL.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(import.meta.dir, 'turnLoop.ts'), 'utf8')

function body(start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `${start} not found`).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(end, from + start.length)
  expect(to, `${end} not found after ${start}`).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('runTurnLoop — MCP lists past their TTL are read before each turn takes its tools', () => {
  const drain = body('const drainCommandQueue = async () => {', 'for await (const message of ask({')

  test('inside the per-command loop, awaited, before the turn reads the store', () => {
    const loop = drain.indexOf('while ((command = dequeue(isMainThread))) {')
    const refresh = drain.indexOf('await refreshExpiredMcpLists(')
    const read = drain.indexOf('const appState = getAppState()')
    expect(loop).toBeGreaterThanOrEqual(0)
    expect(refresh).toBeGreaterThan(loop)
    expect(read).toBeGreaterThan(refresh)
  })

  test('it reads and writes the AppState mcp slice, and writes only when the slice changed', () => {
    expect(drain).toContain('getMcp: () => getAppState().mcp,')
    expect(drain).toMatch(/return mcp === prev\.mcp \? prev : \{ \.\.\.prev, mcp \}/)
  })
})
