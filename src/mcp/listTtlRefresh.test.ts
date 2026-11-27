import { afterEach, describe, expect, test } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  attachMcpWireFilter,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchResourceTemplatesForClient,
  fetchSkillsForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import { getListRecord, resetListTtlRecordsForTests } from 'src/mcp/client/listTtl.js'
import { refreshExpiredMcpLists } from 'src/mcp/listTtlRefresh.js'
import { clearLoadedMcpSkills } from 'src/mcp/mcpSkills.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { type ModernFixture, serveModern } from 'src/mcp/__testutils__/eraServers.js'
import { editableSkills } from 'src/mcp/__testutils__/skillServers.js'
import 'src/skills/loadSkillsDir.js'
import type { AppState } from 'src/terminal/state/AppState.js'

/*
 * The TTL refresh against a real 2026-07-28 server (v2 createMcpHandler) whose
 * lists carry a ttlMs and can change between calls. The clock handed to the
 * refresh is the only thing faked: the records are stamped with the real one,
 * and a ttlMs of 1 lets the SDK's own response cache expire at once, so what
 * reaches the server is what the refresh decided.
 */

type Entry = Record<string, unknown>

type ListState = {
  tools: Entry[]
  prompts: Entry[]
  resources: Entry[]
  ttlMs: number
  failPrompts: boolean
  toolsDelayMs: number
}

const fixtures: ModernFixture[] = []
const clients: Client[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const fixture of fixtures.splice(0)) await fixture.stop()
  resetListTtlRecordsForTests()
  clearLoadedMcpSkills()
})

const tool = (name: string, description = `${name} tool`): Entry => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
})

function serveLists(state: ListState, listChanged: { tools?: boolean } = {}): ModernFixture {
  const fixture = serveModern(server => {
    server.server.registerCapabilities({
      tools: listChanged.tools ? { listChanged: true } : {},
      prompts: {},
      resources: {},
    })
    server.server.setRequestHandler('tools/list', async () => {
      if (state.toolsDelayMs > 0) await Bun.sleep(state.toolsDelayMs)
      return { tools: state.tools, ttlMs: state.ttlMs } as never
    })
    server.server.setRequestHandler('prompts/list', async () => {
      if (state.failPrompts) throw new Error('prompts are down')
      return { prompts: state.prompts, ttlMs: state.ttlMs } as never
    })
    server.server.setRequestHandler('resources/list', async () => ({ resources: state.resources, ttlMs: state.ttlMs }) as never)
    server.server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }) as never)
  })
  fixtures.push(fixture)
  return fixture
}

let seq = 0

async function connect(fixture: ModernFixture): Promise<ConnectedMCPServer> {
  const name = `ttl-${process.pid}-${++seq}`
  const client = new Client({ name: 'list-ttl-test', version: '0' }, { versionNegotiation: { mode: 'auto' } })
  const transport = new StreamableHTTPClientTransport(new URL(fixture.url))
  attachMcpWireFilter(name, transport)
  await client.connect(transport)
  clients.push(client)
  expect(client.getProtocolEra()).toBe('modern')
  return {
    type: 'connected',
    name,
    client,
    capabilities: client.getServerCapabilities() ?? {},
    config: { type: 'http', url: fixture.url, scope: 'local' } as ScopedMcpServerConfig,
    cleanup: () => client.close(),
  }
}

type Store = { mcp: AppState['mcp']; writes: number }

async function loaded(connection: ConnectedMCPServer): Promise<Store> {
  const [tools, commands, resources] = await Promise.all([
    fetchToolsForClient(connection),
    fetchCommandsForClient(connection),
    fetchResourcesForClient(connection),
  ])
  // Past the 1 ms the SDK's response cache holds each list for.
  await Bun.sleep(5)
  return {
    mcp: {
      clients: [connection],
      tools,
      commands,
      resources: resources.length > 0 ? { [connection.name]: resources } : {},
      pluginReconnectKey: 0,
    },
    writes: 0,
  }
}

function refresh(store: Store, aheadMs: number, budgetMs?: number): Promise<void> {
  return refreshExpiredMcpLists({
    getMcp: () => store.mcp,
    setMcp: update => {
      store.writes++
      store.mcp = update(store.mcp)
    },
    now: () => Date.now() + aheadMs,
    ...(budgetMs !== undefined && { budgetMs }),
  })
}

const listCalls = (fixture: ModernFixture, method: string) =>
  fixture.methods().filter(m => m === `POST ${method}`).length

const SOON = 1_000
// Past the 60 s floor plus its largest jitter.
const LATER = 70_000

function state(overrides: Partial<ListState> = {}): ListState {
  return {
    tools: [tool('alpha')],
    prompts: [{ name: 'greet' }],
    resources: [{ uri: 'file:///a', name: 'a' }],
    ttlMs: 1,
    failPrompts: false,
    toolsDelayMs: 0,
    ...overrides,
  }
}

describe('refreshing MCP lists on TTL', () => {
  test('nothing is read again before the floor; once after it, and an unchanged list leaves AppState alone', async () => {
    const lists = state()
    const fixture = serveLists(lists)
    const store = await loaded(await connect(fixture))
    const mcp = store.mcp
    expect(listCalls(fixture, 'tools/list')).toBe(1)

    await refresh(store, SOON)
    expect(listCalls(fixture, 'tools/list')).toBe(1)

    await refresh(store, LATER)
    expect(listCalls(fixture, 'tools/list')).toBe(2)
    expect(listCalls(fixture, 'prompts/list')).toBe(2)
    expect(listCalls(fixture, 'resources/list')).toBe(2)
    expect(store.writes).toBe(0)
    expect(store.mcp).toBe(mcp)
  })

  test('a changed list replaces that server’s entries, and only the list that changed', async () => {
    const lists = state()
    const fixture = serveLists(lists)
    const connection = await connect(fixture)
    const store = await loaded(connection)
    const { commands, resources } = store.mcp

    lists.tools = [tool('alpha', 'now documented'), tool('beta')]
    await refresh(store, LATER)

    expect(store.writes).toBe(1)
    expect(store.mcp.tools.map(t => t.mcpInfo?.toolName)).toEqual(['alpha', 'beta'])
    expect(await store.mcp.tools[0]!.description({} as never, {} as never)).toBe('now documented')
    expect(store.mcp.commands).toBe(commands)
    expect(store.mcp.resources).toBe(resources)
  })

  test('changed resources replace the server’s resources and drop the templates memo', async () => {
    const lists = state()
    const fixture = serveLists(lists)
    const connection = await connect(fixture)
    const store = await loaded(connection)
    await fetchResourceTemplatesForClient(connection)
    expect(fetchResourceTemplatesForClient.cache.has(connection.name)).toBe(true)

    lists.resources = [{ uri: 'file:///b', name: 'b' }]
    await refresh(store, LATER)

    expect(store.mcp.resources[connection.name]?.map(r => r.uri)).toEqual(['file:///b'])
    expect(fetchResourceTemplatesForClient.cache.has(connection.name)).toBe(false)
  })

  test('a server announcing tools/list_changed is never read on TTL for its tools', async () => {
    const fixture = serveLists(state(), { tools: true })
    const store = await loaded(await connect(fixture))
    await refresh(store, 10 * 3_600_000)
    expect(listCalls(fixture, 'tools/list')).toBe(1)
    expect(listCalls(fixture, 'prompts/list')).toBe(2)
  })

  test('a list with ttlMs 0 is never read on TTL', async () => {
    const fixture = serveLists(state({ ttlMs: 0 }))
    const store = await loaded(await connect(fixture))
    await refresh(store, 10 * 3_600_000)
    expect(fixture.methods().filter(m => m.endsWith('/list'))).toHaveLength(3)
    expect(store.writes).toBe(0)
  })

  test('a failing refresh keeps the old list and backs off', async () => {
    const lists = state()
    const fixture = serveLists(lists)
    const connection = await connect(fixture)
    const store = await loaded(connection)
    const commands = store.mcp.commands
    expect(commands).toHaveLength(1)

    lists.failPrompts = true
    await refresh(store, LATER)
    expect(listCalls(fixture, 'prompts/list')).toBe(2)
    expect(store.mcp.commands).toBe(commands)
    expect(getListRecord(connection.name, 'prompts')?.failures).toBe(1)

    // The backoff starts at the failure: still not due at the same clock.
    await refresh(store, LATER)
    expect(listCalls(fixture, 'prompts/list')).toBe(2)

    lists.failPrompts = false
    lists.prompts = [{ name: 'greet' }, { name: 'part' }]
    await refresh(store, 3 * LATER)
    expect(listCalls(fixture, 'prompts/list')).toBe(3)
    expect(store.mcp.commands).toHaveLength(2)
    expect(getListRecord(connection.name, 'prompts')?.failures).toBe(0)
  })

  test('the turn waits only the budget; the read lands afterwards and is not started twice', async () => {
    const lists = state()
    const fixture = serveLists(lists)
    const store = await loaded(await connect(fixture))

    lists.tools = [tool('alpha'), tool('gamma')]
    lists.toolsDelayMs = 400
    const started = Date.now()
    await refresh(store, LATER, 50)
    expect(Date.now() - started).toBeLessThan(350)
    expect(store.mcp.tools).toHaveLength(1)

    // The next turn starts while the read is still out: no second request.
    await refresh(store, 2 * LATER, 50)
    await Bun.sleep(600)
    expect(listCalls(fixture, 'tools/list')).toBe(2)
    expect(store.mcp.tools).toHaveLength(2)
  })

  test('a read that lands after the server reconnected leaves the new connection’s lists alone', async () => {
    const lists = state()
    const fixture = serveLists(lists)
    const connection = await connect(fixture)
    const store = await loaded(connection)

    lists.tools = [tool('alpha'), tool('delta')]
    lists.toolsDelayMs = 200
    const pending = refresh(store, LATER)
    store.mcp = { ...store.mcp, clients: [{ ...connection }] }
    const mcp = store.mcp
    await pending
    expect(store.writes).toBe(1)
    expect(store.mcp).toBe(mcp)
  })

  // Each write replaces the server's client object (applyServerUpdate), so a
  // second write for the same server found it moved and was dropped.
  test('two lists of one server that changed in the same turn land in one write', async () => {
    const lists = state()
    const fixture = serveLists(lists)
    const connection = await connect(fixture)
    const store = await loaded(connection)

    lists.tools = [tool('alpha'), tool('beta')]
    lists.resources = [{ uri: 'file:///b', name: 'b' }]
    // The tools answer after the resources.
    lists.toolsDelayMs = 100
    await refresh(store, LATER)

    expect(store.writes).toBe(1)
    expect(store.mcp.tools.map(t => t.mcpInfo?.toolName)).toEqual(['alpha', 'beta'])
    expect(store.mcp.resources[connection.name]?.map(r => r.uri)).toEqual(['file:///b'])
  })

  test('a changed list whose write was dropped is read and written again on a later turn', async () => {
    const lists = state()
    const fixture = serveLists(lists)
    const connection = await connect(fixture)
    const store = await loaded(connection)

    lists.tools = [tool('alpha'), tool('beta')]
    lists.toolsDelayMs = 200
    const pending = refresh(store, LATER)
    // Another write for the server lands meanwhile and replaces its client object.
    store.mcp = { ...store.mcp, clients: [{ ...connection }] }
    await pending
    expect(store.mcp.tools.map(t => t.mcpInfo?.toolName)).toEqual(['alpha'])

    lists.toolsDelayMs = 0
    await Bun.sleep(5)
    await refresh(store, 2 * LATER)
    expect(listCalls(fixture, 'tools/list')).toBe(3)
    expect(store.mcp.tools.map(t => t.mcpInfo?.toolName)).toEqual(['alpha', 'beta'])
  })

  test('servers that are not connected are skipped', async () => {
    const fixture = serveLists(state())
    const connection = await connect(fixture)
    const store = await loaded(connection)
    store.mcp = { ...store.mcp, clients: [{ name: connection.name, type: 'failed', config: connection.config }] }
    await refresh(store, LATER)
    expect(listCalls(fixture, 'tools/list')).toBe(1)
  })

  test('changed prompts keep the skills that share the server’s commands', async () => {
    const skills = editableSkills()
    await skills.add('notes', { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nKeep notes.\n' })
    let prompts = [{ name: 'greet' }]
    const fixture = serveModern(server => {
      skills.extension.attach(server)
      server.server.registerCapabilities({ prompts: {} })
      server.server.setRequestHandler('prompts/list', async () => ({ prompts, ttlMs: 1 }) as never)
    })
    fixtures.push(fixture)
    const connection = await connect(fixture)
    const commands = [...(await fetchCommandsForClient(connection)), ...(await fetchSkillsForClient(connection))]
    await Bun.sleep(5)
    const store: Store = {
      mcp: { clients: [connection], tools: [], commands, resources: {}, pluginReconnectKey: 0 },
      writes: 0,
    }
    const name = (suffix: string) => `${connection.name}${suffix}`
    expect(commands.map(c => c.name)).toEqual([`mcp__${connection.name}__greet`, name(':notes')])

    prompts = [{ name: 'greet' }, { name: 'wave' }]
    await refresh(store, LATER)
    expect(store.writes).toBe(1)
    expect(store.mcp.commands.map(c => c.name)).toEqual([
      `mcp__${connection.name}__greet`,
      `mcp__${connection.name}__wave`,
      name(':notes'),
    ])
  })
})
