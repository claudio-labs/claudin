/**
 * mcp/core, part 3: the helpers in src/mcp/utils.ts that need no settings.
 *
 * Grouping a server's tools, prompts, skills and resources (the /mcp menus,
 * disconnect and reload clean-up), the config fingerprint that decides when a
 * reload reconnects a server, the argument checks behind `claudin mcp add`,
 * the agent-declared servers shown in /mcp, and the URL that is safe to log.
 */
import { describe, expect, test } from 'bun:test'
import type { Command } from 'src/commands/commands.js'
import { ConfigScopeSchema, type MCPServerConnection, type ScopedMcpServerConfig, type ServerResource } from 'src/mcp/types.js'
import {
  commandBelongsToServer,
  ensureConfigScope,
  ensureTransport,
  excludeCommandsByServer,
  excludeResourcesByServer,
  excludeStalePluginClients,
  excludeToolsByServer,
  extractAgentMcpServers,
  filterMcpPromptsByServer,
  filterToolsByServer,
  getLoggingSafeMcpBaseUrl,
  getScopeLabel,
  hashMcpConfig,
  isMcpTool,
  parseHeaders,
} from 'src/mcp/utils.js'
import type { Tool } from 'src/tools/Tool.js'
import { parseAgentsFromJson } from 'src/tools/AgentTool/loadAgentsDir.js'

const tool = (name: string | undefined, isMcp?: boolean): Tool => ({ name, ...(isMcp === undefined ? {} : { isMcp }) }) as unknown as Tool
const prompt = (name: string, loadedFrom?: string): Command =>
  ({ type: 'prompt', name, description: name, ...(loadedFrom ? { loadedFrom } : { isMcp: true }) }) as unknown as Command
const local = (name: string): Command => ({ type: 'local', name, description: name }) as unknown as Command
const names = (xs: Array<{ name?: string }>): Array<string | undefined> => xs.map(x => x.name)

const resource = (server: string, uri: string): ServerResource => ({ server, uri, name: uri }) as ServerResource

describe('a server\'s tools', () => {
  const pool = [
    tool('mcp__github__create_issue'),
    tool('mcp__github__list'),
    tool('mcp__githubx__list'),
    tool('mcp__git__status'),
    tool('mcp__my_server__read'),
    tool('mcp__team__ops__deploy'),
    tool('Read'),
    tool(undefined),
  ]

  const cases: Array<[server: string, mine: string[]]> = [
    ['github', ['mcp__github__create_issue', 'mcp__github__list']],
    ['git', ['mcp__git__status']],
    ['my.server', ['mcp__my_server__read']],
    ['team', ['mcp__team__ops__deploy']],
    ['team__ops', ['mcp__team__ops__deploy']],
    ['absent', []],
  ]
  test.each(cases)('server %p owns %p, and excluding it leaves the rest', (server, mine) => {
    expect(names(filterToolsByServer(pool, server))).toEqual(mine)
    expect(names(excludeToolsByServer(pool, server))).toEqual(names(pool).filter(n => !mine.includes(n as string)))
  })

  test('a tool without a name belongs to no server and survives every exclusion', () => {
    expect(excludeToolsByServer(pool, 'github')).toContain(pool[7]!)
  })
})

describe('a server\'s commands', () => {
  const cmds = [
    prompt('mcp__github__triage'),
    prompt('github:review', 'mcp'),
    prompt('github:legacy', 'plugin'),
    local('github'),
    prompt('githubx:other', 'mcp'),
    prompt('mcp__my_server__ask'),
    prompt('my_server:skill', 'mcp'),
    prompt('my.server:raw', 'mcp'),
    prompt(''),
  ]

  const owned: Array<[server: string, mine: string[]]> = [
    ['github', ['mcp__github__triage', 'github:review', 'github:legacy']],
    ['my.server', ['mcp__my_server__ask', 'my_server:skill']],
    ['nobody', []],
  ]
  test.each(owned)('server %p owns %p, by MCP prefix or by "<server>:" skill prefix', (server, mine) => {
    expect(names(cmds.filter(c => commandBelongsToServer(c, server)))).toEqual(mine)
    expect(names(excludeCommandsByServer(cmds, server))).toEqual(names(cmds).filter(n => !mine.includes(n as string)))
  })

  test('the prompts of a server leave out its MCP skills, but keep a skill-shaped name from elsewhere', () => {
    expect(names(filterMcpPromptsByServer(cmds, 'github'))).toEqual(['mcp__github__triage', 'github:legacy'])
    expect(names(filterMcpPromptsByServer(cmds, 'my.server'))).toEqual(['mcp__my_server__ask'])
  })

  test('a command with an empty name belongs to no server', () => {
    expect(commandBelongsToServer(prompt(''), '')).toBe(false)
  })
})

describe('a server\'s resources', () => {
  test('are removed by the exact key, and the input is left alone', () => {
    const all: Record<string, ServerResource[]> = {
      github: [resource('github', 'gh://a')],
      'my.server': [resource('my.server', 'f://b')],
    }
    const out = excludeResourcesByServer(all, 'github')
    expect(Object.keys(out)).toEqual(['my.server'])
    expect(Object.keys(all)).toEqual(['github', 'my.server'])
    expect(out).not.toBe(all)
  })

  test('the key is not normalized', () => {
    const all = { 'my.server': [resource('my.server', 'f://b')] }
    expect(Object.keys(excludeResourcesByServer(all, 'my_server'))).toEqual(['my.server'])
  })
})

describe('isMcpTool', () => {
  const cases: Array<[label: string, t: Tool, out: boolean]> = [
    ['an mcp__ name', tool('mcp__fs__read'), true],
    ['a bare mcp__ prefix', tool('mcp__'), true],
    ['flagged, under a builtin-looking name', tool('Write', true), true],
    ['a builtin', tool('Read'), false],
    ['flag explicitly false', tool('Read', false), false],
    ['upper case prefix', tool('MCP__fs__read'), false],
    ['a single underscore', tool('mcp_fs'), false],
  ]
  test.each(cases)('%s → %p', (_label, t, out) => {
    expect(isMcpTool(t)).toBe(out)
  })
})

describe('hashMcpConfig', () => {
  const base: ScopedMcpServerConfig = { type: 'http', url: 'https://h/mcp', headers: { A: '1', B: '2' }, scope: 'project' }

  test('is 16 lowercase hex digits', () => {
    expect(hashMcpConfig(base)).toMatch(/^[0-9a-f]{16}$/)
  })

  const same: Array<[label: string, other: ScopedMcpServerConfig]> = [
    ['another scope', { ...base, scope: 'user' }],
    ['keys in another order', { headers: { B: '2', A: '1' }, scope: 'local', url: 'https://h/mcp', type: 'http' }],
    ['an explicit undefined field', { ...base, headersHelper: undefined }],
  ]
  test.each(same)('does not change with %s', (_label, other) => {
    expect(hashMcpConfig(other)).toBe(hashMcpConfig(base))
  })

  const differ: Array<[label: string, other: ScopedMcpServerConfig]> = [
    ['the url', { ...base, url: 'https://h/mcp2' }],
    ['a header value', { ...base, headers: { A: '1', B: '3' } }],
    ['the providing plugin', { ...base, pluginSource: 'tools@market' }],
    ['the type', { ...base, type: 'sse' } as ScopedMcpServerConfig],
  ]
  test.each(differ)('changes with %s', (_label, other) => {
    expect(hashMcpConfig(other)).not.toBe(hashMcpConfig(base))
  })

  test('argument order matters for stdio', () => {
    const a: ScopedMcpServerConfig = { command: 'srv', args: ['--a', '--b'], scope: 'dynamic' }
    const b: ScopedMcpServerConfig = { command: 'srv', args: ['--b', '--a'], scope: 'dynamic' }
    expect(hashMcpConfig(a)).not.toBe(hashMcpConfig(b))
  })
})

describe('excludeStalePluginClients', () => {
  const cfg = (scope: ScopedMcpServerConfig['scope'], url = 'https://h'): ScopedMcpServerConfig => ({ type: 'http', url, scope })
  const conn = (name: string, config: ScopedMcpServerConfig, type: MCPServerConnection['type'] = 'connected'): MCPServerConnection =>
    ({ name, type, config }) as MCPServerConnection

  function state(clients: MCPServerConnection[]) {
    return {
      clients,
      tools: clients.flatMap(c => [tool(`mcp__${c.name}__t`)]).concat(tool('Read')),
      commands: clients.flatMap(c => [prompt(`mcp__${c.name}__p`), prompt(`${c.name}:s`, 'mcp')]).concat(local('help')),
      resources: Object.fromEntries(clients.map(c => [c.name, [resource(c.name, `${c.name}://r`)]])),
    }
  }

  test('nothing stale: the same lists come back, with an empty stale list', () => {
    const s = state([conn('keep', cfg('project'))])
    const out = excludeStalePluginClients(s, { keep: cfg('project') })
    expect(out.stale).toEqual([])
    expect(out.clients).toBe(s.clients)
    expect(out.tools).toBe(s.tools)
    expect(out.commands).toBe(s.commands)
    expect(out.resources).toBe(s.resources)
  })

  const cases: Array<[label: string, client: MCPServerConnection, configs: Record<string, ScopedMcpServerConfig>, stale: boolean]> = [
    ['a dynamic server gone from the configs', conn('plug', cfg('dynamic')), {}, true],
    ['a project server gone from the configs', conn('proj', cfg('project')), {}, false],
    ['a user server gone from the configs', conn('usr', cfg('user')), {}, false],
    ['a server whose url changed', conn('proj', cfg('project')), { proj: cfg('project', 'https://other') }, true],
    ['a server that only moved scope', conn('proj', cfg('project')), { proj: cfg('local') }, false],
    ['a failed server whose config changed', conn('bad', cfg('user'), 'failed'), { bad: cfg('user', 'https://new') }, true],
  ]
  test.each(cases)('%s → stale: %p', (_label, client, configs, isStale) => {
    const s = state([client, conn('steady', cfg('user'))])
    const out = excludeStalePluginClients(s, { ...configs, steady: cfg('user') })
    expect(out.stale.map(c => c.name)).toEqual(isStale ? [client.name] : [])
    expect(out.clients.map(c => c.name)).toEqual(isStale ? ['steady'] : [client.name, 'steady'])
  })

  test('a stale server takes its tools, prompts, skills and resources with it', () => {
    const s = state([conn('plug', cfg('dynamic')), conn('steady', cfg('user'))])
    const out = excludeStalePluginClients(s, { steady: cfg('user') })
    expect(names(out.tools)).toEqual(['mcp__steady__t', 'Read'])
    expect(names(out.commands)).toEqual(['mcp__steady__p', 'steady:s', 'help'])
    expect(Object.keys(out.resources)).toEqual(['steady'])
    expect(out.stale.map(c => c.name)).toEqual(['plug'])
  })
})

describe('arguments of `mcp add`', () => {
  test('a scope defaults to local, and every listed scope passes', () => {
    expect(ensureConfigScope()).toBe('local')
    expect(ensureConfigScope('')).toBe('local')
    for (const s of ['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed']) expect(ensureConfigScope(s) as string).toBe(s)
  })

  test.each(['global', 'Local', 'workspace'])('scope %p is refused with the list of valid ones', bad => {
    expect(() => ensureConfigScope(bad)).toThrow(
      `Invalid scope: ${bad}. Must be one of: local, user, project, dynamic, enterprise, claudeai, managed`,
    )
  })

  test('a transport defaults to stdio, and only stdio, sse and http pass', () => {
    expect(ensureTransport()).toBe('stdio')
    expect(ensureTransport('')).toBe('stdio')
    for (const t of ['stdio', 'sse', 'http']) expect(ensureTransport(t) as string).toBe(t)
  })

  test.each(['ws', 'sdk', 'sse-ide', 'HTTP'])('transport %p is refused', bad => {
    expect(() => ensureTransport(bad)).toThrow(`Invalid transport type: ${bad}. Must be one of: stdio, sse, http`)
  })

  const headers: Array<[label: string, given: string[], out: Record<string, string>]> = [
    ['none', [], {}],
    ['name and value are trimmed', ['  X-Api-Key :  abc  '], { 'X-Api-Key': 'abc' }],
    ['only the first colon splits', ['Authorization: Bearer a:b:c'], { Authorization: 'Bearer a:b:c' }],
    ['no space after the colon', ['X-A:1'], { 'X-A': '1' }],
    ['an empty value is allowed', ['X-Empty:'], { 'X-Empty': '' }],
    ['the last of a repeated name wins, case kept as typed', ['X-A: 1', 'x-a: 2', 'X-A: 3'], { 'X-A': '3', 'x-a': '2' }],
  ]
  test.each(headers)('headers: %s', (_label, given, out) => {
    expect(parseHeaders(given)).toEqual(out)
  })

  test('a header without a colon is refused, quoted back with the expected shape', () => {
    for (const given of ['X-No-Colon', '']) {
      expect(() => parseHeaders(['Ok: 1', given])).toThrow(`Invalid header format: "${given}". Expected format: "Header-Name: value"`)
    }
  })

  test('a header whose name is blank is refused, quoted back', () => {
    for (const given of [': value', '   : value']) {
      expect(() => parseHeaders(['Ok: 1', given])).toThrow(`Invalid header: "${given}". Header name cannot be empty.`)
    }
  })
})

describe('the scope labels', () => {
  test('every scope has its label; managed falls back to the scope word', () => {
    const shown = Object.fromEntries(ConfigScopeSchema().options.map(scope => [scope, getScopeLabel(scope)]))
    expect(shown).toEqual({
      local: 'Local config (private to you in this project)',
      user: 'User config (available in all your projects)',
      project: 'Project config (shared via .mcp.json)',
      dynamic: 'Dynamic config (from command line)',
      enterprise: 'Enterprise config (managed by your organization)',
      claudeai: 'claude.ai config',
      managed: 'managed',
    })
  })
})

describe('servers declared by agents', () => {
  const agents = parseAgentsFromJson({
    reviewer: {
      description: 'reviews',
      prompt: 'review',
      mcpServers: [
        'github',
        { linter: { command: 'lint-mcp', args: ['--strict'] } },
        { tracker: { type: 'http', url: 'https://t.example/mcp' } },
      ],
    },
    planner: {
      description: 'plans',
      prompt: 'plan',
      mcpServers: [
        { linter: { command: 'other-lint' } },
        { events: { type: 'sse', url: 'https://e.example/sse' } },
        { live: { type: 'ws', url: 'wss://l.example' } },
        { inproc: { type: 'sdk', name: 'inproc' } },
        { a: { command: 'a' }, b: { command: 'b' } },
        {},
      ],
    },
    tester: { description: 'tests', prompt: 'test', mcpServers: [{ linter: { command: 'lint-mcp' } }] },
    quiet: { description: 'none', prompt: 'none' },
  })

  test('the agents parse as given', () => {
    expect(agents.map(a => a.agentType)).toEqual(['reviewer', 'planner', 'tester', 'quiet'])
  })

  test('inline servers are grouped by name, the first definition wins, and name references are skipped', () => {
    expect(extractAgentMcpServers(agents)).toEqual([
      { name: 'events', sourceAgents: ['planner'], transport: 'sse', url: 'https://e.example/sse', needsAuth: true },
      { name: 'linter', sourceAgents: ['reviewer', 'planner', 'tester'], transport: 'stdio', command: 'lint-mcp', needsAuth: false },
      { name: 'live', sourceAgents: ['planner'], transport: 'ws', url: 'wss://l.example', needsAuth: false },
      { name: 'tracker', sourceAgents: ['reviewer'], transport: 'http', url: 'https://t.example/mcp', needsAuth: true },
    ])
  })

  test('an agent naming the same server twice is listed once', () => {
    const twice = parseAgentsFromJson({
      dup: { description: 'd', prompt: 'p', mcpServers: [{ s: { command: 'x' } }, { s: { command: 'y' } }] },
    })
    expect(extractAgentMcpServers(twice)).toEqual([{ name: 's', sourceAgents: ['dup'], transport: 'stdio', command: 'x', needsAuth: false }])
  })

  test('the list is sorted by name with locale order', () => {
    const mixed = parseAgentsFromJson({
      m: { description: 'm', prompt: 'p', mcpServers: [{ beta: { command: 'b' } }, { Alpha: { command: 'a' } }, { alpha: { command: 'a' } }] },
    })
    expect(extractAgentMcpServers(mixed).map(s => s.name)).toEqual(['alpha', 'Alpha', 'beta'])
  })

  test('no agents, no servers', () => {
    expect(extractAgentMcpServers([])).toEqual([])
  })
})

describe('the URL that is safe to log', () => {
  const cases: Array<[label: string, config: object, out: string | undefined]> = [
    ['the query string goes (it can carry a token)', { type: 'http', url: 'https://h.example/mcp?token=s3cr3t&x=1' }, 'https://h.example/mcp'],
    ['one trailing slash goes', { type: 'sse', url: 'https://h.example/sse/' }, 'https://h.example/sse'],
    ['a bare origin loses its slash', { type: 'http', url: 'https://h.example' }, 'https://h.example'],
    ['the fragment stays', { type: 'http', url: 'https://h.example/p#frag' }, 'https://h.example/p#frag'],
    ['a websocket URL', { type: 'ws', url: 'wss://h.example/ws?k=v' }, 'wss://h.example/ws'],
    ['a stdio server has none', { command: 'srv' }, undefined],
    ['an sdk server has none', { type: 'sdk', name: 'n' }, undefined],
    ['an unparseable URL gives none', { type: 'http', url: 'not a url' }, undefined],
  ]
  test.each(cases)('%s', (_label, config, out) => {
    expect(getLoggingSafeMcpBaseUrl(config as never)).toBe(out)
  })
})
