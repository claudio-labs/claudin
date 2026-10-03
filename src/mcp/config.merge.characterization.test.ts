/**
 * Characterization of how every MCP scope is merged into the servers a
 * session connects to (src/mcp/config.ts): `getClaudeCodeMcpConfigs`,
 * `getAllMcpConfigs`, the de-duplication helpers and their signature, and
 * `areMcpConfigsAllowedWithEnterpriseMcpConfig`.
 *
 * Plugins are real plugin directories loaded as --plugin-dir; the claude.ai
 * connector listing is the one network answer, seeded per test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setAllowedSettingSources, setIsInteractive } from 'src/platform/bootstrap/state.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  dedupClaudeAiMcpServers,
  dedupPluginMcpServers,
  getAllMcpConfigs,
  getClaudeCodeMcpConfigs,
  getMcpServerSignature,
  unwrapCcrProxyUrl,
} from 'src/mcp/config.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import {
  addPlugin,
  enterWorld,
  leaveWorld,
  serveClaudeAi,
  setLocalServers,
  setToggles,
  setUserServers,
  withEnv,
  writeManagedMcp,
  writeMcpJson,
  writeSettings,
  type Json,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'

let undoEnv: () => void = () => {}

beforeEach(() => {
  enterWorld()
})

afterEach(() => {
  undoEnv()
  undoEnv = () => {}
  leaveWorld()
})

type Scoped = Record<string, ScopedMcpServerConfig>
const scoped = (servers: Json, scope: ScopedMcpServerConfig['scope']): Scoped =>
  Object.fromEntries(Object.entries(servers).map(([k, v]) => [k, { ...(v as object), scope }])) as Scoped

/** "name=scope:command-or-url" for each server, in result order. */
function summary(servers: Record<string, unknown>): string[] {
  return Object.entries(servers).map(([name, raw]) => {
    const c = raw as { scope: string; command?: string; url?: string }
    return `${name}=${c.scope}:${c.command ?? c.url}`
  })
}

const approveAll = () => writeSettings('local', { enableAllProjectMcpServers: true })

describe('getClaudeCodeMcpConfigs: precedence', () => {
  test('one name in every scope: local beats project beats user beats plugin', async () => {
    addPlugin('kit', { tool: { command: 'from-plugin' } })
    const order: string[] = []
    const layers = [
      () => setLocalServers({ 'plugin:kit:tool': { command: 'from-local' } }),
      () => {
        writeMcpJson({ mcpServers: { 'plugin:kit:tool': { command: 'from-project' } } })
        approveAll()
      },
      () => setUserServers({ 'plugin:kit:tool': { command: 'from-user' } }),
    ]
    for (const add of [...layers].reverse()) {
      add()
      order.push(summary((await getClaudeCodeMcpConfigs()).servers).join(','))
    }
    expect(order).toEqual([
      'plugin:kit:tool=user:from-user',
      'plugin:kit:tool=project:from-project',
      'plugin:kit:tool=local:from-local',
    ])
  })

  test('result order: plugin servers, then user, project and local', async () => {
    addPlugin('kit', { tool: { command: 'pt' } })
    setUserServers({ u: { command: 'u' } })
    setLocalServers({ l: { command: 'l' } })
    writeMcpJson({ mcpServers: { p: { command: 'p' } } })
    approveAll()
    expect(summary((await getClaudeCodeMcpConfigs()).servers)).toEqual(['plugin:kit:tool=dynamic:pt', 'u=user:u', 'p=project:p', 'l=local:l'])
  })

  test('servers handed in as dynamic are not part of the result', async () => {
    const { servers } = await getClaudeCodeMcpConfigs(scoped({ cli: { command: 'c', args: [] } }, 'dynamic'))
    expect(servers).toEqual({})
  })

  test('validation errors of the file scopes are not returned here', async () => {
    writeMcpJson('{"mcpServers": 1}')
    setUserServers({ bad: { type: 'ws' } })
    expect(await getClaudeCodeMcpConfigs()).toEqual({ servers: {}, errors: [] })
  })

  test('user, project and local servers come back expanded', async () => {
    undoEnv = withEnv({ CHAR_MCP_M: 'm' })
    setUserServers({ u: { command: '${CHAR_MCP_M}-u' } })
    writeMcpJson({ mcpServers: { p: { command: '${CHAR_MCP_M}-p' } } })
    approveAll()
    expect(summary((await getClaudeCodeMcpConfigs()).servers)).toEqual(['u=user:m-u', 'p=project:m-p'])
  })
})

describe('getClaudeCodeMcpConfigs: approval of project servers', () => {
  type Row = [why: string, layer: 'local' | 'user' | 'project' | null, settings: Json, interactive: boolean, connected: string[]]
  const rows: Row[] = [
    ['nobody approved them (interactive)', null, {}, true, []],
    ['a non-interactive session approves them all', null, {}, false, ['a', 'b', 'b.x']],
    ['listed as enabled', 'local', { enabledMcpjsonServers: ['a'] }, true, ['a']],
    ['enabled through the normalized name', 'local', { enabledMcpjsonServers: ['b_x'] }, true, ['b.x']],
    ['enable-all', 'local', { enableAllProjectMcpServers: true }, true, ['a', 'b', 'b.x']],
    ['rejected beats enabled', 'local', { enabledMcpjsonServers: ['a', 'b'], disabledMcpjsonServers: ['a'] }, true, ['b']],
    ['rejected beats enable-all', 'local', { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['b'] }, true, ['a', 'b.x']],
    ['rejected beats a non-interactive session', 'local', { disabledMcpjsonServers: ['a'] }, false, ['b', 'b.x']],
    ['the user skipped the dangerous-mode prompt', 'user', { skipDangerousModePermissionPrompt: true }, true, ['a', 'b', 'b.x']],
    ['the repository cannot skip the dangerous-mode prompt for the user', 'project', { skipDangerousModePermissionPrompt: true }, true, []],
    ['the repository can approve its own servers by name', 'project', { enabledMcpjsonServers: ['a'] }, true, ['a']],
  ]

  test.each(rows)('%s', async (_why, layer, settings, interactive, connected) => {
    writeMcpJson({ mcpServers: { a: { command: 'a' }, b: { command: 'b' }, 'b.x': { command: 'bx' } } })
    if (layer) writeSettings(layer, settings)
    setIsInteractive(interactive)
    expect(Object.keys((await getClaudeCodeMcpConfigs()).servers)).toEqual(connected)
  })

  test('with projectSettings off, a non-interactive session approves nothing (and no file is read)', async () => {
    writeMcpJson({ mcpServers: { a: { command: 'a' } } })
    setIsInteractive(false)
    setAllowedSettingSources(['userSettings', 'localSettings'])
    expect((await getClaudeCodeMcpConfigs()).servers).toEqual({})
  })
})

describe('getClaudeCodeMcpConfigs: the managed MCP file takes over', () => {
  test('only managed servers, policy-filtered; no plugins, no other scope, no errors', async () => {
    addPlugin('kit', { tool: { command: 'pt', env: { K: '${CHAR_MCP_NOPE}' } } })
    setUserServers({ u: { command: 'u' } })
    setLocalServers({ l: { command: 'l' } })
    writeMcpJson({ mcpServers: { p: { command: 'p' } } })
    approveAll()
    writeManagedMcp({ mcpServers: { org: { command: 'org' }, banned: { command: 'b' } } })
    writeSettings('policy', { deniedMcpServers: [{ serverName: 'banned' }] })
    expect(await getClaudeCodeMcpConfigs(scoped({ d: { command: 'd', args: [] } }, 'dynamic'))).toEqual({
      servers: { org: { command: 'org', args: [], scope: 'enterprise' } },
      errors: [],
    })
  })

  test('an empty managed file still shuts every other scope out', async () => {
    setUserServers({ u: { command: 'u' } })
    writeManagedMcp({ mcpServers: {} })
    expect((await getClaudeCodeMcpConfigs()).servers).toEqual({})
  })

  test('a managed file that does not parse does not take over', async () => {
    setUserServers({ u: { command: 'u' } })
    writeManagedMcp('{"mcpServers": [}')
    expect(Object.keys((await getClaudeCodeMcpConfigs()).servers)).toEqual(['u'])
  })
})

describe('getClaudeCodeMcpConfigs: the plugin-only lock', () => {
  test.each([
    ['true', true, true],
    ['a list naming mcp', ['skills', 'mcp'], true],
    ['a list without mcp', ['skills'], false],
  ] as const)('strictPluginOnlyCustomization %s', async (_why, value, locked) => {
    addPlugin('kit', { tool: { command: 'pt' } })
    setUserServers({ u: { command: 'u' } })
    setLocalServers({ l: { command: 'l' } })
    writeMcpJson({ mcpServers: { p: { command: 'p' } } })
    approveAll()
    writeSettings('policy', { strictPluginOnlyCustomization: value })
    const names = Object.keys((await getClaudeCodeMcpConfigs()).servers)
    expect(names).toEqual(locked ? ['plugin:kit:tool'] : ['plugin:kit:tool', 'u', 'p', 'l'])
  })
})

describe('getClaudeCodeMcpConfigs: policy on the merged result', () => {
  test('a denied server is dropped from every scope', async () => {
    addPlugin('kit', { tool: { command: 'pt' } })
    setUserServers({ u: { command: 'bad' } })
    setLocalServers({ l: { type: 'http', url: 'https://bad.example/x' } })
    writeMcpJson({ mcpServers: { p: { command: 'p' } } })
    approveAll()
    writeSettings('policy', {
      deniedMcpServers: [{ serverCommand: ['bad'] }, { serverUrl: 'https://bad.example/*' }, { serverCommand: ['pt'] }, { serverName: 'p' }],
    })
    expect((await getClaudeCodeMcpConfigs()).servers).toEqual({})
  })

  test('an sdk entry in a config scope is filtered like any other (by name)', async () => {
    setUserServers({ inproc: { type: 'sdk', name: 'x' }, named: { type: 'sdk', name: 'y' } })
    writeSettings('policy', { allowedMcpServers: [{ serverName: 'named' }] })
    expect(Object.keys((await getClaudeCodeMcpConfigs()).servers)).toEqual(['named'])
  })

  test('an allowlist drops what it does not list, plugin servers included', async () => {
    addPlugin('kit', { tool: { command: 'pt' } })
    setUserServers({ ok: { command: 'ok' }, nope: { command: 'nope' } })
    writeSettings('policy', { allowedMcpServers: [{ serverCommand: ['ok'] }] })
    expect(Object.keys((await getClaudeCodeMcpConfigs()).servers)).toEqual(['ok'])
  })
})

describe('getClaudeCodeMcpConfigs: plugin servers and duplicates', () => {
  test('plugin servers are namespaced, tagged dynamic, and carry their plugin source', async () => {
    addPlugin('kit', { tool: { type: 'http', url: 'https://kit.example/mcp' } })
    const tool = (await getClaudeCodeMcpConfigs()).servers['plugin:kit:tool'] as ScopedMcpServerConfig & { pluginSource?: string }
    expect([tool.scope, tool.pluginSource, (tool as { url: string }).url]).toEqual(['dynamic', 'kit@inline', 'https://kit.example/mcp'])
  })

  test('a plugin server that duplicates a manual one is suppressed, and reported', async () => {
    addPlugin('kit', { same: { command: 'srv', args: ['--x'], env: { DIFFERENT: '1' } }, own: { command: 'own' } })
    setUserServers({ mine: { command: 'srv', args: ['--x'] } })
    const { servers, errors } = await getClaudeCodeMcpConfigs()
    expect(Object.keys(servers)).toEqual(['plugin:kit:own', 'mine'])
    expect(errors).toEqual([
      { type: 'mcp-server-suppressed-duplicate', source: 'plugin:kit:same', plugin: 'kit', serverName: 'same', duplicateOf: 'mine' },
    ])
  })

  test('between plugins, the first loaded wins', async () => {
    addPlugin('first', { s: { type: 'sse', url: 'https://same/sse' } })
    addPlugin('second', { s: { type: 'sse', url: 'https://same/sse' } })
    const { servers, errors } = await getClaudeCodeMcpConfigs()
    expect(Object.keys(servers)).toEqual(['plugin:first:s'])
    expect(errors.map(e => (e as { duplicateOf?: string }).duplicateOf)).toEqual(['plugin:first:s'])
  })

  test('a disabled manual server does not suppress its plugin twin', async () => {
    addPlugin('kit', { same: { command: 'srv' } })
    setUserServers({ mine: { command: 'srv' } })
    setToggles({ disabled: ['mine'] })
    expect(Object.keys((await getClaudeCodeMcpConfigs()).servers)).toEqual(['plugin:kit:same', 'mine'])
  })

  test('a manual server the policy blocks does not suppress its plugin twin', async () => {
    addPlugin('kit', { same: { type: 'http', url: 'https://x/mcp' } })
    setUserServers({ mine: { type: 'http', url: 'https://x/mcp' } })
    writeSettings('policy', { deniedMcpServers: [{ serverName: 'mine' }] })
    expect(Object.keys((await getClaudeCodeMcpConfigs()).servers)).toEqual(['plugin:kit:same'])
  })

  test('a project server waiting for approval does not suppress its plugin twin', async () => {
    addPlugin('kit', { same: { command: 'srv' } })
    writeMcpJson({ mcpServers: { proj: { command: 'srv' } } })
    expect(Object.keys((await getClaudeCodeMcpConfigs()).servers)).toEqual(['plugin:kit:same'])
  })

  test('a disabled plugin server neither wins the race nor disappears', async () => {
    addPlugin('first', { s: { command: 'same' } })
    addPlugin('second', { s: { command: 'same' } })
    setToggles({ disabled: ['plugin:first:s'] })
    const { servers, errors } = await getClaudeCodeMcpConfigs()
    expect(Object.keys(servers).sort()).toEqual(['plugin:first:s', 'plugin:second:s'])
    expect(errors).toEqual([])
  })

  test('dynamic servers and enabled extra targets suppress plugin twins without joining the result', async () => {
    addPlugin('kit', { a: { command: 'cli' }, b: { type: 'http', url: 'https://conn/x' }, c: { command: 'kept' } })
    const run = () =>
      getClaudeCodeMcpConfigs(
        scoped({ fromCli: { command: 'cli', args: [] } }, 'dynamic'),
        Promise.resolve(scoped({ 'claude.ai Conn': { type: 'claudeai-proxy', url: 'https://conn/x', id: 'i' } }, 'claudeai')),
      )
    // A connector is off until the user turns it on, and an off server is no dedup target.
    expect(Object.keys((await run()).servers)).toEqual(['plugin:kit:b', 'plugin:kit:c'])
    setToggles({ enabled: ['claude.ai Conn'] })
    const { servers, errors } = await run()
    expect(Object.keys(servers)).toEqual(['plugin:kit:c'])
    expect(errors.map(e => (e as { duplicateOf?: string }).duplicateOf)).toEqual(['fromCli', 'claude.ai Conn'])
  })

  test('a plugin server with an unset variable is kept, and its error is returned', async () => {
    undoEnv = withEnv({ CHAR_MCP_PLUGIN_KEY: undefined })
    addPlugin('kit', { needs: { command: 'n', env: { KEY: '${CHAR_MCP_PLUGIN_KEY}' } } })
    const { servers, errors } = await getClaudeCodeMcpConfigs()
    expect(Object.keys(servers)).toEqual(['plugin:kit:needs'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ type: 'mcp-config-invalid', plugin: 'kit', serverName: 'needs' })
  })

  test('a plugin that cannot be loaded is not an MCP error', async () => {
    addPlugin('kit', { s: { command: 's' } })
    const { setInlinePlugins, getInlinePlugins } = await import('src/platform/bootstrap/state.js')
    setInlinePlugins([...getInlinePlugins(), '/nonexistent/plugin/dir'])
    const { servers, errors } = await getClaudeCodeMcpConfigs()
    expect([Object.keys(servers), errors]).toEqual([['plugin:kit:s'], []])
  })
})

describe('getAllMcpConfigs: claude.ai connectors', () => {
  const connector = (url: string, id = 'c1'): ScopedMcpServerConfig => ({ type: 'claudeai-proxy', url, id, scope: 'claudeai' }) as ScopedMcpServerConfig

  test('connectors join with the lowest precedence, ahead of the rest', async () => {
    serveClaudeAi({ 'claude.ai Slack': connector('https://slack/mcp'), shared: connector('https://shared/mcp', 'c2') })
    setUserServers({ shared: { command: 'mine' }, u: { command: 'u' } })
    expect(summary((await getAllMcpConfigs()).servers)).toEqual(['claude.ai Slack=claudeai:https://slack/mcp', 'shared=user:mine', 'u=user:u'])
  })

  test('a connector that duplicates an enabled manual server by URL is dropped, silently', async () => {
    serveClaudeAi({ 'claude.ai Slack': connector('https://mcp.slack.com/mcp') })
    setUserServers({ slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } })
    expect(await getAllMcpConfigs()).toEqual({ servers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp', scope: 'user' } }, errors: [] })
    setToggles({ disabled: ['slack'] })
    expect(Object.keys((await getAllMcpConfigs()).servers)).toEqual(['claude.ai Slack', 'slack'])
  })

  test('connectors go through the policy', async () => {
    serveClaudeAi({ 'claude.ai A': connector('https://a/mcp'), 'claude.ai B': connector('https://b/mcp', 'c2') })
    writeSettings('policy', { deniedMcpServers: [{ serverUrl: 'https://a/*' }] })
    expect(Object.keys((await getAllMcpConfigs()).servers)).toEqual(['claude.ai B'])
  })

  test('with a managed MCP file, no connector is merged', async () => {
    serveClaudeAi({ 'claude.ai A': connector('https://a/mcp') })
    writeManagedMcp({ mcpServers: { org: { command: 'o' } } })
    expect(Object.keys((await getAllMcpConfigs()).servers)).toEqual(['org'])
  })

  test('connector or plugin twin: the enabled connector wins, otherwise the plugin', async () => {
    serveClaudeAi({ 'claude.ai Notion': connector('https://notion/mcp') })
    addPlugin('kit', { notion: { type: 'http', url: 'https://notion/mcp' } })
    expect(await getAllMcpConfigs()).toEqual({
      servers: { 'plugin:kit:notion': { type: 'http', url: 'https://notion/mcp', scope: 'dynamic', pluginSource: 'kit@inline' } as never },
      errors: [],
    })
    setToggles({ enabled: ['claude.ai Notion'] })
    const { servers, errors } = await getAllMcpConfigs()
    expect(Object.keys(servers)).toEqual(['claude.ai Notion'])
    expect(errors.map(e => e.type)).toEqual(['mcp-server-suppressed-duplicate'])
  })
})

describe('the server signature', () => {
  test.each([
    ['stdio, untyped', { command: 'npx', args: ['-y', 'pkg'] }, 'stdio:["npx","-y","pkg"]'],
    ['stdio, typed, env ignored', { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } }, 'stdio:["npx","-y","pkg"]'],
    ['stdio without args', { command: 'bin' }, 'stdio:["bin"]'],
    ['http, headers ignored', { type: 'http', url: 'https://h/mcp', headers: { A: 'b' } }, 'url:https://h/mcp'],
    ['sse', { type: 'sse', url: 'https://h/sse' }, 'url:https://h/sse'],
    ['ws', { type: 'ws', url: 'wss://h' }, 'url:wss://h'],
    ['an IDE transport', { type: 'sse-ide', url: 'http://127.0.0.1:1', ideName: 'x' }, 'url:http://127.0.0.1:1'],
    ['a claude.ai proxy, unwrapped', { type: 'claudeai-proxy', url: 'https://api/v2/ccr-sessions/s/mcp?mcp_url=https%3A%2F%2Fvendor%2Fmcp', id: 'i' }, 'url:https://vendor/mcp'],
    ['sdk', { type: 'sdk', name: 'x' }, null],
  ] as const)('%s', (_why, config, signature) => {
    expect(getMcpServerSignature(config as never)).toBe(signature)
  })
})

describe('unwrapCcrProxyUrl', () => {
  test.each([
    ['a session-ingress proxy URL', 'https://api.example/v2/session_ingress/shttp/mcp/abc?mcp_url=https%3A%2F%2Fmcp.vendor.com%2Fv1', 'https://mcp.vendor.com/v1'],
    ['a ccr-sessions proxy URL', 'https://api.example/v2/ccr-sessions/s1/mcp?x=1&mcp_url=https://v/mcp', 'https://v/mcp'],
    ['a proxy URL without mcp_url', 'https://api.example/v2/ccr-sessions/s1', 'https://api.example/v2/ccr-sessions/s1'],
    ['a proxy URL with an empty mcp_url', 'https://api.example/v2/ccr-sessions/s1?mcp_url=', 'https://api.example/v2/ccr-sessions/s1?mcp_url='],
    ['the marker in the query still counts', 'https://h/x?a=/v2/ccr-sessions/&mcp_url=https://v', 'https://v'],
    ['a marker in a string that is not a URL', 'not a url /v2/ccr-sessions/ ?mcp_url=x', 'not a url /v2/ccr-sessions/ ?mcp_url=x'],
    ['an ordinary URL with mcp_url', 'https://h/mcp?mcp_url=https://v', 'https://h/mcp?mcp_url=https://v'],
    ['a near miss of the marker', 'https://h/v2/ccr-session/x?mcp_url=https://v', 'https://h/v2/ccr-session/x?mcp_url=https://v'],
  ])('%s', (_why, url, expected) => {
    expect(unwrapCcrProxyUrl(url)).toBe(expected)
  })
})

describe('the de-duplication helpers', () => {
  test('dedupPluginMcpServers: manual wins, the first manual name is reported, sdk entries pass', () => {
    const manual = scoped({ m1: { command: 'x', args: [] }, m2: { command: 'x', args: [] }, r: { type: 'http', url: 'https://r' } }, 'user')
    const plugins = scoped(
      {
        'plugin:a:dupCmd': { command: 'x', args: [] },
        'plugin:a:dupUrl': { type: 'sse', url: 'https://r' },
        'plugin:a:sdk1': { type: 'sdk', name: 'n' },
        'plugin:b:sdk2': { type: 'sdk', name: 'n' },
        'plugin:a:solo': { command: 'y', args: [] },
        'plugin:b:solo': { command: 'y', args: [] },
      },
      'dynamic',
    )
    const { servers, suppressed } = dedupPluginMcpServers(plugins, manual)
    expect(Object.keys(servers)).toEqual(['plugin:a:sdk1', 'plugin:b:sdk2', 'plugin:a:solo'])
    expect(servers['plugin:a:solo']).toBe(plugins['plugin:a:solo'])
    expect(suppressed).toEqual([
      { name: 'plugin:a:dupCmd', duplicateOf: 'm1' },
      { name: 'plugin:a:dupUrl', duplicateOf: 'r' },
      { name: 'plugin:b:solo', duplicateOf: 'plugin:a:solo' },
    ])
  })

  test('dedupClaudeAiMcpServers: only enabled manual servers count; connectors never dedupe each other', () => {
    setToggles({ disabled: ['off'] })
    const manual = scoped({ off: { type: 'http', url: 'https://off' }, on: { type: 'http', url: 'https://on' }, also: { type: 'sse', url: 'https://on' } }, 'user')
    const connectors = scoped(
      {
        'claude.ai Off': { type: 'claudeai-proxy', url: 'https://off', id: '1' },
        'claude.ai On': { type: 'claudeai-proxy', url: 'https://on', id: '2' },
        'claude.ai Twin1': { type: 'claudeai-proxy', url: 'https://t', id: '3' },
        'claude.ai Twin2': { type: 'claudeai-proxy', url: 'https://t', id: '4' },
      },
      'claudeai',
    )
    const { servers, suppressed } = dedupClaudeAiMcpServers(connectors, manual)
    expect(Object.keys(servers)).toEqual(['claude.ai Off', 'claude.ai Twin1', 'claude.ai Twin2'])
    expect(suppressed).toEqual([{ name: 'claude.ai On', duplicateOf: 'on' }])
  })
})

describe('areMcpConfigsAllowedWithEnterpriseMcpConfig', () => {
  test.each([
    ['nothing', {}, true],
    ['only the VS Code SDK server', { v: { type: 'sdk', name: 'claude-vscode' } }, true],
    ['another SDK server', { v: { type: 'sdk', name: 'claude-vscode' }, o: { type: 'sdk', name: 'other' } }, false],
    ['a stdio server', { s: { command: 'claude-vscode' } }, false],
  ] as const)('%s -> %p', (_why, configs, ok) => {
    expect(areMcpConfigsAllowedWithEnterpriseMcpConfig(scoped(configs as Json, 'dynamic'))).toBe(ok)
  })
})
