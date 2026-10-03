/**
 * Characterization of the managed allow/deny policy for MCP servers
 * (src/mcp/config.ts), seen through `filterMcpServersByPolicy`,
 * `shouldAllowManagedMcpServersOnly` and the policy gate of `addMcpConfig`.
 *
 * Security-weighted: every deny path has a row, and each row writes the
 * policy as a real managed-settings.json (or a user settings.json where the
 * point is a user's own list).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { addMcpConfig, filterMcpServersByPolicy, getMcpConfigsByScope, shouldAllowManagedMcpServersOnly } from 'src/mcp/config.js'
import { enterWorld, leaveWorld, writeSettings, type Json, type SettingsLayer } from 'src/mcp/__testutils__/mcpConfigWorld.js'

beforeEach(() => {
  enterWorld()
})

afterEach(() => {
  leaveWorld()
})

const NODE = { command: 'node', args: ['srv.js'] }
const REMOTE = { type: 'http', url: 'https://mcp.example.com/v1' }

/** One server, one policy, one verdict. */
type Case = {
  why: string
  policy: Json
  name?: string
  server: Json
  allowed: boolean
}

function verdict(policy: Json, name: string, server: Json, layer: SettingsLayer = 'policy'): boolean {
  writeSettings(layer, policy)
  const { allowed, blocked } = filterMcpServersByPolicy({ [name]: server })
  expect(Object.keys(allowed).length + blocked.length).toBe(1)
  return name in allowed
}

const denyCases: Case[] = [
  { why: 'no policy at all', policy: {}, server: NODE, allowed: true },
  { why: 'denied by name', policy: { deniedMcpServers: [{ serverName: 'srv' }] }, server: NODE, allowed: false },
  { why: 'a name deny hits a remote server too', policy: { deniedMcpServers: [{ serverName: 'srv' }] }, server: REMOTE, allowed: false },
  { why: 'a name deny for another name', policy: { deniedMcpServers: [{ serverName: 'other' }] }, server: NODE, allowed: true },
  { why: 'names compare exactly (case)', policy: { deniedMcpServers: [{ serverName: 'SRV' }] }, server: NODE, allowed: true },
  { why: 'denied by the exact command array', policy: { deniedMcpServers: [{ serverCommand: ['node', 'srv.js'] }] }, server: NODE, allowed: false },
  { why: 'a command deny is per element: a missing arg does not match', policy: { deniedMcpServers: [{ serverCommand: ['node'] }] }, server: NODE, allowed: true },
  { why: 'a command deny is ordered', policy: { deniedMcpServers: [{ serverCommand: ['srv.js', 'node'] }] }, server: NODE, allowed: true },
  { why: 'a command deny with no args matches a server with no args', policy: { deniedMcpServers: [{ serverCommand: ['node'] }] }, server: { command: 'node' }, allowed: false },
  { why: 'a typed stdio server is matched by command', policy: { deniedMcpServers: [{ serverCommand: ['node', 'srv.js'] }] }, server: { type: 'stdio', ...NODE }, allowed: false },
  { why: 'a command deny never hits a remote server', policy: { deniedMcpServers: [{ serverCommand: ['node', 'srv.js'] }] }, server: REMOTE, allowed: true },
  { why: 'denied by an exact URL', policy: { deniedMcpServers: [{ serverUrl: 'https://mcp.example.com/v1' }] }, server: REMOTE, allowed: false },
  { why: 'denied by a host wildcard', policy: { deniedMcpServers: [{ serverUrl: 'https://*.example.com/*' }] }, server: REMOTE, allowed: false },
  { why: 'a URL pattern is anchored at both ends', policy: { deniedMcpServers: [{ serverUrl: 'https://mcp.example.com' }] }, server: REMOTE, allowed: true },
  { why: 'a dot in the pattern is literal', policy: { deniedMcpServers: [{ serverUrl: 'https://mcp.example.com/v1' }] }, server: { type: 'http', url: 'https://mcpXexample.com/v1' }, allowed: true },
  { why: 'other regex characters are literal too', policy: { deniedMcpServers: [{ serverUrl: 'https://h/a+b?(c)' }] }, server: { type: 'sse', url: 'https://h/a+b?(c)' }, allowed: false },
  { why: 'a star crosses path separators', policy: { deniedMcpServers: [{ serverUrl: 'https://*/v1' }] }, server: { type: 'ws', url: 'https://a/b/c/v1' }, allowed: false },
  { why: 'a URL deny covers IDE transports', policy: { deniedMcpServers: [{ serverUrl: 'ws://127.0.0.1:*' }] }, server: { type: 'ws-ide', url: 'ws://127.0.0.1:9', ideName: 'x' }, allowed: false },
  { why: 'a URL deny covers claude.ai proxies', policy: { deniedMcpServers: [{ serverUrl: 'https://proxy/*' }] }, server: { type: 'claudeai-proxy', url: 'https://proxy/x', id: 'i' }, allowed: false },
  { why: 'a URL deny never hits a stdio server', policy: { deniedMcpServers: [{ serverUrl: '*' }] }, server: NODE, allowed: true },
  { why: 'deny beats an allow by name', policy: { allowedMcpServers: [{ serverName: 'srv' }], deniedMcpServers: [{ serverName: 'srv' }] }, server: NODE, allowed: false },
  { why: 'deny beats an allow by command', policy: { allowedMcpServers: [{ serverCommand: ['node', 'srv.js'] }], deniedMcpServers: [{ serverUrl: '*' }, { serverName: 'srv' }] }, server: NODE, allowed: false },
]

const allowCases: Case[] = [
  { why: 'an empty allowlist blocks everything', policy: { allowedMcpServers: [] }, server: NODE, allowed: false },
  { why: 'allowed by name (stdio)', policy: { allowedMcpServers: [{ serverName: 'srv' }] }, server: NODE, allowed: true },
  { why: 'allowed by name (remote)', policy: { allowedMcpServers: [{ serverName: 'srv' }] }, server: REMOTE, allowed: true },
  { why: 'not on a name-only allowlist', policy: { allowedMcpServers: [{ serverName: 'other' }] }, server: NODE, allowed: false },
  { why: 'allowed by exact command', policy: { allowedMcpServers: [{ serverCommand: ['node', 'srv.js'] }] }, server: NODE, allowed: true },
  { why: 'with any command entry, a stdio name entry no longer suffices', policy: { allowedMcpServers: [{ serverName: 'srv' }, { serverCommand: ['python'] }] }, server: NODE, allowed: false },
  { why: 'command entries do not constrain remote servers, which fall back to names', policy: { allowedMcpServers: [{ serverName: 'srv' }, { serverCommand: ['python'] }] }, server: REMOTE, allowed: true },
  { why: 'command entries alone block every remote server', policy: { allowedMcpServers: [{ serverCommand: ['node', 'srv.js'] }] }, server: REMOTE, allowed: false },
  { why: 'allowed by URL pattern', policy: { allowedMcpServers: [{ serverUrl: 'https://*.example.com/*' }] }, server: REMOTE, allowed: true },
  { why: 'with any URL entry, a remote name entry no longer suffices', policy: { allowedMcpServers: [{ serverName: 'srv' }, { serverUrl: 'https://other/*' }] }, server: REMOTE, allowed: false },
  { why: 'URL entries do not constrain stdio servers, which fall back to names', policy: { allowedMcpServers: [{ serverName: 'srv' }, { serverUrl: 'https://other/*' }] }, server: NODE, allowed: true },
  { why: 'URL entries alone block every stdio server', policy: { allowedMcpServers: [{ serverUrl: '*' }] }, server: NODE, allowed: false },
  { why: 'the host wildcard also accepts a look-alike path on another host', policy: { allowedMcpServers: [{ serverUrl: 'https://*.example.com/*' }] }, server: { type: 'http', url: 'https://evil.test/x.example.com/' }, allowed: true },
  { why: 'an sdk server is exempt from an empty allowlist', policy: { allowedMcpServers: [] }, server: { type: 'sdk', name: 'x' }, allowed: true },
  { why: 'an sdk server is exempt from a name deny', policy: { deniedMcpServers: [{ serverName: 'srv' }] }, server: { type: 'sdk', name: 'srv' }, allowed: true },
]

describe('filterMcpServersByPolicy: deny entries', () => {
  test.each(denyCases.map(c => [c.why, c] as const))('%s', (_why, c) => {
    expect(verdict(c.policy, c.name ?? 'srv', c.server)).toBe(c.allowed)
  })
})

describe('filterMcpServersByPolicy: allow entries', () => {
  test.each(allowCases.map(c => [c.why, c] as const))('%s', (_why, c) => {
    expect(verdict(c.policy, c.name ?? 'srv', c.server)).toBe(c.allowed)
  })
})

describe('filterMcpServersByPolicy: the result', () => {
  test('keeps allowed entries as given (same object), and lists blocked names in input order', () => {
    writeSettings('policy', { deniedMcpServers: [{ serverName: 'b1' }, { serverName: 'b2' }] })
    const keep = { command: 'k', extra: 'kept' }
    const { allowed, blocked } = filterMcpServersByPolicy({ b2: NODE, keep, b1: REMOTE })
    expect(allowed).toEqual({ keep })
    expect(allowed.keep).toBe(keep)
    expect(blocked).toEqual(['b2', 'b1'])
  })

  test('a server with no args (the SDK wire shape) is matched as command only', () => {
    writeSettings('policy', { allowedMcpServers: [{ serverCommand: ['uvx'] }] })
    expect(filterMcpServersByPolicy({ a: { command: 'uvx' }, b: { command: 'uvx', args: ['x'] } })).toEqual({
      allowed: { a: { command: 'uvx' } },
      blocked: ['b'],
    })
  })

  test('an empty input gives an empty result', () => {
    expect(filterMcpServersByPolicy({})).toEqual({ allowed: {}, blocked: [] })
  })
})

describe('whose lists count', () => {
  test('a user can deny for themselves', () => {
    expect(verdict({ deniedMcpServers: [{ serverName: 'srv' }] }, 'srv', NODE, 'user')).toBe(false)
  })

  test('a project settings file can deny too', () => {
    expect(verdict({ deniedMcpServers: [{ serverCommand: ['node', 'srv.js'] }] }, 'srv', NODE, 'project')).toBe(false)
  })

  test('allowlists from user and policy are merged unless the policy claims the allowlist', () => {
    writeSettings('user', { allowedMcpServers: [{ serverName: 'mine' }] })
    writeSettings('policy', { allowedMcpServers: [{ serverName: 'org' }] })
    expect(filterMcpServersByPolicy({ mine: NODE, org: NODE, other: NODE }).blocked).toEqual(['other'])

    writeSettings('policy', { allowedMcpServers: [{ serverName: 'org' }], allowManagedMcpServersOnly: true })
    expect(filterMcpServersByPolicy({ mine: NODE, org: NODE, other: NODE }).blocked).toEqual(['mine', 'other'])
  })

  test('when the policy claims the allowlist, a user deny still applies', () => {
    writeSettings('user', { deniedMcpServers: [{ serverName: 'org' }] })
    writeSettings('policy', { allowedMcpServers: [{ serverName: 'org' }], allowManagedMcpServersOnly: true })
    expect(filterMcpServersByPolicy({ org: NODE }).blocked).toEqual(['org'])
  })

  test('a claimed allowlist that the policy leaves unset allows everything, whatever the user lists', () => {
    writeSettings('user', { allowedMcpServers: [] })
    writeSettings('policy', { allowManagedMcpServersOnly: true })
    expect(filterMcpServersByPolicy({ any: NODE }).blocked).toEqual([])
  })

  test.each([
    ['policy', { allowManagedMcpServersOnly: true }, true],
    ['policy', { allowManagedMcpServersOnly: false }, false],
    ['policy', {}, false],
    ['user', { allowManagedMcpServersOnly: true }, false],
    ['local', { allowManagedMcpServersOnly: true }, false],
  ] as const)('shouldAllowManagedMcpServersOnly: %s %p -> %p', (layer, settings, expected) => {
    writeSettings(layer, settings)
    expect(shouldAllowManagedMcpServersOnly()).toBe(expected)
  })
})

describe('addMcpConfig refuses what the policy refuses', () => {
  test.each([
    ['a name deny', { deniedMcpServers: [{ serverName: 'srv' }] }, 'Cannot add MCP server "srv": server is explicitly blocked by enterprise policy'],
    ['a command deny', { deniedMcpServers: [{ serverCommand: ['node', 'srv.js'] }] }, 'Cannot add MCP server "srv": server is explicitly blocked by enterprise policy'],
    ['an allowlist without it', { allowedMcpServers: [{ serverName: 'other' }] }, 'Cannot add MCP server "srv": not allowed by enterprise policy'],
    ['an empty allowlist', { allowedMcpServers: [] }, 'Cannot add MCP server "srv": not allowed by enterprise policy'],
  ] as const)('%s', async (_why, policy, message) => {
    writeSettings('policy', policy)
    await expect(addMcpConfig('srv', NODE, 'user')).rejects.toThrow(message)
    expect(getMcpConfigsByScope('user').servers).toEqual({})
  })

  test('the policy sees the config after validation: a URL deny on a remote server', async () => {
    writeSettings('policy', { deniedMcpServers: [{ serverUrl: 'https://mcp.example.com/*' }] })
    await expect(addMcpConfig('remote', REMOTE, 'local')).rejects.toThrow('explicitly blocked by enterprise policy')
  })

  test('an sdk server is not exempt here: only a name entry admits it', async () => {
    const sdk = { type: 'sdk', name: 'in-process' }
    writeSettings('policy', { allowedMcpServers: [{ serverCommand: ['x'] }, { serverUrl: '*' }] })
    await expect(addMcpConfig('sdkA', sdk, 'user')).rejects.toThrow('Cannot add MCP server "sdkA": not allowed by enterprise policy')
    writeSettings('policy', { allowedMcpServers: [{ serverName: 'sdkB' }, { serverCommand: ['x'] }, { serverUrl: '*' }] })
    await addMcpConfig('sdkB', sdk, 'user')
    expect(Object.keys(getMcpConfigsByScope('user').servers)).toEqual(['sdkB'])
  })

  test('the policy lets an allowed server through', async () => {
    writeSettings('policy', { allowedMcpServers: [{ serverCommand: ['node', 'srv.js'] }] })
    await addMcpConfig('srv', NODE, 'user')
    expect(Object.keys(getMcpConfigsByScope('user').servers)).toEqual(['srv'])
  })
})
