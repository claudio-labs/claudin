import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEraCacheKey, readEraVerdict, saveEraVerdict, setEraCacheDirForTests } from 'src/mcp/client/eraCache.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { handleMcpReconnect, type McpServerNameRequest } from 'src/platform/headless/print/mcpControlHandlers.js'
import type { HeadlessStreamingContext } from 'src/platform/headless/print/streamingContext.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'era-cache-reconnect-'))
  setEraCacheDirForTests(dir)
})

afterEach(() => {
  setEraCacheDirForTests(undefined)
  rmSync(dir, { recursive: true, force: true })
})

test('an mcp_reconnect control request drops the era verdict, as /mcp reconnect does', async () => {
  const name = 'headless-reconnect-era'
  const config = { command: join(dir, 'no-such-server'), scope: 'dynamic' } as ScopedMcpServerConfig
  const key = getEraCacheKey(name, config)
  await saveEraVerdict(key, { kind: 'legacy', savedAt: Date.now(), ttlMs: 60_000 })

  const errors: string[] = []
  const ctx = {
    getAppState: () => ({ mcp: { clients: [], tools: [], commands: [], resources: {} } }),
    setAppState: () => {},
    initialMcpClients: [{ name, type: 'pending', config }],
    sdkClients: [],
    dynamicMcpState: { clients: [], tools: [] },
    elicitationRegistered: new Set<string>(),
    registerElicitationHandlers: () => {},
    sendControlResponseSuccess: () => {},
    sendControlResponseError: (_message: unknown, error: string) => void errors.push(error),
  } as unknown as HeadlessStreamingContext
  const message = { request: { subtype: 'mcp_reconnect', serverName: name } } as McpServerNameRequest

  await handleMcpReconnect(ctx, message)

  expect(errors).toHaveLength(1)
  expect(await readEraVerdict(key)).toBeUndefined()
})
