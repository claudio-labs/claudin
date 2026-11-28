import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import { setEraCacheDirForTests } from 'src/mcp/client/eraCache.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import { type ModernFixture, serveModern } from 'src/mcp/__testutils__/eraServers.js'
import { editableSkills } from 'src/mcp/__testutils__/skillServers.js'

/*
 * On the 2026-07-28 wire the SDK rejects every result without `resultType`,
 * and a cacheable one (the lists, resources/read, skills/list) without
 * `ttlMs` and `cacheScope` too. A real v2 server (createMcpHandler) is
 * connected through connectToServer, and its answers are replaced, raw, by
 * ones that leave those fields out; the wire rules give each the defaults the
 * spec gives an absent hint.
 */

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
let savedConfigDir: string | undefined
let dir = ''
let fixture: ModernFixture | undefined
const connections: MCPServerConnection[] = []

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
  savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'wire-modern-results-'))
  process.env.CLAUDIN_CONFIG_DIR = dir
  setEraCacheDirForTests(dir)
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => ({}),
    readAsync: async () => ({}),
    update: () => ({ success: true }),
    delete: () => true,
  })
})

afterEach(async () => {
  for (const c of connections.splice(0)) {
    if (c.type === 'connected') await c.cleanup().catch(() => {})
    connectToServer.cache.delete(getServerCacheKey(c.name, c.config))
  }
  await fixture?.stop()
  fixture = undefined
  _setSecureStorageForTesting(null)
  setEraCacheDirForTests(undefined)
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(dir, { recursive: true, force: true })
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

const RESULTS: Record<string, Record<string, unknown>> = {
  'tools/list': { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
  'tools/call': { content: [{ type: 'text', text: 'called' }] },
  'resources/read': { contents: [{ uri: 'docs://a', text: 'A' }] },
  'prompts/get': { messages: [{ role: 'user', content: { type: 'text', text: 'P' } }] },
  'completion/complete': { completion: { values: ['x'] } },
  'skills/list': { skills: [] },
}

let seq = 0

/** A v2 server whose answers to RESULTS' methods carry no ttlMs or cacheScope, and no resultType unless `withResultType`. */
async function connectSloppy(withResultType: boolean): Promise<ConnectedMCPServer> {
  const skills = editableSkills()
  fixture = serveModern(
    server => {
      skills.extension.attach(server)
      server.server.registerCapabilities({ tools: {}, prompts: {}, resources: {}, completions: {} })
    },
    {
      answer: body => {
        const result = RESULTS[String(body?.method)]
        if (result === undefined) return undefined
        return Response.json({
          jsonrpc: '2.0',
          id: body?.id,
          result: withResultType ? { resultType: 'complete', ...result } : result,
        })
      },
    },
  )
  const name = `sloppy-${process.pid}-${++seq}`
  const config = { type: 'http', url: fixture.url, scope: 'user' } as ScopedMcpServerConfig
  const connection = await connectToServer(name, config)
  connections.push(connection)
  if (connection.type !== 'connected') throw new Error(`not connected: ${connection.type}`)
  expect(connection.client.getProtocolEra()).toBe('modern')
  return connection
}

function outcome<T>(p: Promise<T>, read: (value: T) => unknown): Promise<unknown> {
  return p.then(
    value => read(value),
    (e: unknown) => `rejected: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
  )
}

async function everyResult(c: ConnectedMCPServer) {
  return {
    list: await outcome(c.client.listTools(), r => r.tools.map(t => t.name)),
    call: await outcome(c.client.callTool({ name: 't', arguments: {} }), r => r.content),
    read: await outcome(c.client.readResource({ uri: 'docs://a' }), r => r.contents),
    prompt: await outcome(c.client.getPrompt({ name: 'p' }), r => r.messages.length),
    complete: await outcome(
      c.client.complete({ ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: '' } }),
      r => r.completion.values,
    ),
    skills: await outcome(new SkillsClient(c.client, { skipInvalid: true }).list(), r => r.skills),
  }
}

const EXPECTED = {
  list: ['t'],
  call: [{ type: 'text', text: 'called' }],
  read: [{ uri: 'docs://a', text: 'A' }],
  prompt: 1,
  complete: ['x'],
  skills: [],
}

describe('modern results without the fields the SDK requires', () => {
  test('without ttlMs and cacheScope: every result Claudin reads is accepted', async () => {
    expect(await everyResult(await connectSloppy(true))).toEqual(EXPECTED)
  })

  test('without resultType either: every result Claudin reads is accepted', async () => {
    expect(await everyResult(await connectSloppy(false))).toEqual(EXPECTED)
  })

  test('a read gets the defaults of an absent hint: immediately stale, private', async () => {
    const c = await connectSloppy(false)
    expect(await c.client.readResource({ uri: 'docs://a' })).toMatchObject({ ttlMs: 0, cacheScope: 'private' })
  })
})
