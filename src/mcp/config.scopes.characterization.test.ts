/**
 * Characterization of reading one MCP scope at a time (src/mcp/config.ts):
 * `getMcpConfigsByScope`, `getProjectMcpConfigsFromCwd`, `getMcpConfigByName`,
 * `getEnterpriseMcpFilePath` and `doesEnterpriseMcpConfigExist`.
 *
 * Real `.mcp.json` and `managed-mcp.json` files in a temp tree; the user and
 * local scopes go through the global config (see the world harness).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { setAllowedSettingSources } from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import {
  doesEnterpriseMcpConfigExist,
  getEnterpriseMcpFilePath,
  getMcpConfigByName,
  getMcpConfigsByScope,
  getProjectMcpConfigsFromCwd,
} from 'src/mcp/config.js'
import {
  enterWorld,
  leaveWorld,
  setLocalServers,
  setToggles,
  setUserServers,
  withEnv,
  writeManagedMcp,
  writeMcpJson,
  writeSettings,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'

let w: World
let undoEnv: () => void = () => {}

beforeEach(() => {
  w = enterWorld()
})

afterEach(() => {
  undoEnv()
  undoEnv = () => {}
  leaveWorld()
})

const stdio = (command: string) => ({ command, args: [] })

describe('the managed file', () => {
  test('lives in the managed directory as managed-mcp.json', () => {
    expect(getEnterpriseMcpFilePath()).toBe(join(w.admin, 'managed-mcp.json'))
  })

  test.each([
    ['absent', null, false],
    ['valid', { mcpServers: { a: { command: 'x' } } }, true],
    ['valid and empty', { mcpServers: {} }, true],
    ['valid with an unset variable', { mcpServers: { a: { command: '${CHAR_MCP_UNSET_X}' } } }, true],
    ['not JSON', '{oops', false],
    ['off-schema', { mcpServers: { a: { type: 'nope' } } }, false],
  ] as const)('%s: exists = %p', (_why, content, exists) => {
    if (content !== null) writeManagedMcp(content as never)
    expect(doesEnterpriseMcpConfigExist()).toBe(exists)
  })

  test('the answer is kept for the process: a file written afterwards is not noticed', () => {
    expect(doesEnterpriseMcpConfigExist()).toBe(false)
    // Written behind the harness's back, so no cache is dropped.
    writeFileSync(getEnterpriseMcpFilePath(), '{"mcpServers":{}}')
    expect(doesEnterpriseMcpConfigExist()).toBe(false)
    doesEnterpriseMcpConfigExist.cache.clear?.()
    expect(doesEnterpriseMcpConfigExist()).toBe(true)
  })
})

describe('getMcpConfigsByScope("enterprise")', () => {
  test('servers come back expanded and tagged enterprise', () => {
    undoEnv = withEnv({ CHAR_MCP_ORG: 'acme' })
    writeManagedMcp({ mcpServers: { org: { type: 'http', url: 'https://${CHAR_MCP_ORG}.example/mcp' }, tool: { command: 't' } } })
    expect(getMcpConfigsByScope('enterprise')).toEqual({
      servers: {
        org: { type: 'http', url: 'https://acme.example/mcp', scope: 'enterprise' },
        tool: { ...stdio('t'), scope: 'enterprise' },
      },
      errors: [],
    })
  })

  test('a missing file is silent; a broken one reports with the file name', () => {
    expect(getMcpConfigsByScope('enterprise')).toEqual({ servers: {}, errors: [] })
    const path = writeManagedMcp('[')
    const { servers, errors } = getMcpConfigsByScope('enterprise')
    expect(servers).toEqual({})
    expect(errors.map(e => [e.file, e.message, e.mcpErrorMetadata?.scope])).toEqual([[path, 'MCP config is not a valid JSON', 'enterprise']])
  })

  test('is read even when every user-editable source is turned off', () => {
    writeManagedMcp({ mcpServers: { org: { command: 'o' } } })
    setAllowedSettingSources([])
    expect(Object.keys(getMcpConfigsByScope('enterprise').servers)).toEqual(['org'])
  })
})

describe('getMcpConfigsByScope("project"): the upward walk', () => {
  test('every ancestor .mcp.json is read, and the nearer file wins a name outright', () => {
    writeMcpJson({ mcpServers: { shared: { command: 'outer', env: { ONLY_OUTER: '1' } }, parentOnly: { command: 'p' } } }, w.outer)
    writeMcpJson({ mcpServers: { shared: { command: 'inner' }, here: { command: 'h' } } })
    expect(getMcpConfigsByScope('project')).toEqual({
      servers: {
        shared: { ...stdio('inner'), scope: 'project' },
        parentOnly: { ...stdio('p'), scope: 'project' },
        here: { ...stdio('h'), scope: 'project' },
      },
      errors: [],
    })
  })

  test('a broken ancestor reports its error and does not hide the nearer file', () => {
    const parentFile = writeMcpJson('{"mcpServers": ', w.outer)
    writeMcpJson({ mcpServers: { here: { command: 'h' } } })
    const { servers, errors } = getMcpConfigsByScope('project')
    expect(Object.keys(servers)).toEqual(['here'])
    expect(errors.map(e => [e.file, e.message])).toEqual([[parentFile, 'MCP config is not a valid JSON']])
  })

  test('warnings from every level are collected, farthest first', () => {
    undoEnv = withEnv({ CHAR_MCP_P1: undefined, CHAR_MCP_P2: undefined })
    writeMcpJson({ mcpServers: { a: { command: '${CHAR_MCP_P1}' } } }, w.outer)
    writeMcpJson({ mcpServers: { b: { command: '${CHAR_MCP_P2}' } } })
    const { servers, errors } = getMcpConfigsByScope('project')
    expect(Object.keys(servers).sort()).toEqual(['a', 'b'])
    expect(errors.map(e => [e.path, e.mcpErrorMetadata?.severity])).toEqual([
      ['mcpServers.a', 'warning'],
      ['mcpServers.b', 'warning'],
    ])
  })

  test('no file anywhere: nothing, and no error', () => {
    expect(getMcpConfigsByScope('project')).toEqual({ servers: {}, errors: [] })
  })
})

describe('getProjectMcpConfigsFromCwd: the cwd only', () => {
  test('reads the cwd file and ignores ancestors', () => {
    writeMcpJson({ mcpServers: { up: { command: 'u' } } }, w.outer)
    writeMcpJson({ mcpServers: { here: { type: 'ws', url: 'wss://h' } } })
    expect(getProjectMcpConfigsFromCwd()).toEqual({
      servers: { here: { type: 'ws', url: 'wss://h', scope: 'project' } },
      errors: [],
    })
  })

  test('missing: empty and silent; broken: empty with the errors; warnings ride along with servers', () => {
    expect(getProjectMcpConfigsFromCwd()).toEqual({ servers: {}, errors: [] })

    const path = writeMcpJson({ mcpServers: { x: { type: 'sse' } } })
    expect(getProjectMcpConfigsFromCwd()).toEqual({
      servers: {},
      errors: [{ file: path, path: 'mcpServers.x', message: 'Does not adhere to MCP server configuration schema', mcpErrorMetadata: { scope: 'project', severity: 'fatal' } }],
    })

    undoEnv = withEnv({ CHAR_MCP_Q: undefined })
    writeMcpJson({ mcpServers: { y: { command: '${CHAR_MCP_Q}' } } })
    const result = getProjectMcpConfigsFromCwd()
    expect(Object.keys(result.servers)).toEqual(['y'])
    expect(result.errors.map(e => e.message)).toEqual(['Missing environment variables: CHAR_MCP_Q'])
  })
})

describe('user and local scopes', () => {
  test.each(['user', 'local'] as const)('%s: servers from the global config, expanded and tagged', scope => {
    undoEnv = withEnv({ CHAR_MCP_U: 'from-env' })
    const servers = { s: { command: '${CHAR_MCP_U}' }, r: { type: 'sse', url: 'https://${CHAR_MCP_U}/' } }
    if (scope === 'user') setUserServers(servers)
    else setLocalServers(servers)
    expect(getMcpConfigsByScope(scope)).toEqual({
      servers: {
        s: { ...stdio('from-env'), scope },
        r: { type: 'sse', url: 'https://from-env/', scope },
      },
      errors: [],
    })
  })

  test.each(['user', 'local'] as const)('%s: nothing stored gives nothing; a bad entry gives errors and no servers', scope => {
    expect(getMcpConfigsByScope(scope)).toEqual({ servers: {}, errors: [] })
    const set = scope === 'user' ? setUserServers : setLocalServers
    set({ good: { command: 'g' }, bad: { type: 'http' } })
    const { servers, errors } = getMcpConfigsByScope(scope)
    expect(servers).toEqual({})
    expect(errors).toEqual([{ path: 'mcpServers.bad', message: 'Does not adhere to MCP server configuration schema', mcpErrorMetadata: { scope, severity: 'fatal' } }])
  })
})

describe('setting sources gate their scope', () => {
  const rows: Array<[scope: 'user' | 'project' | 'local', source: SettingSource]> = [
    ['user', 'userSettings'],
    ['project', 'projectSettings'],
    ['local', 'localSettings'],
  ]

  test.each(rows)('%s is empty when %s is off, and only then', (scope, source) => {
    setUserServers({ u: { command: 'u' } })
    setLocalServers({ l: { command: 'l' } })
    writeMcpJson({ mcpServers: { p: { command: 'p' } } })
    const everyOther = (['userSettings', 'projectSettings', 'localSettings'] as SettingSource[]).filter(s => s !== source)
    setAllowedSettingSources(everyOther)
    expect(getMcpConfigsByScope(scope)).toEqual({ servers: {}, errors: [] })
    setAllowedSettingSources([source])
    expect(Object.keys(getMcpConfigsByScope(scope).servers)).toEqual([scope[0]!])
  })

  test('the cwd-only read follows projectSettings too', () => {
    writeMcpJson({ mcpServers: { p: { command: 'p' } } })
    setAllowedSettingSources(['userSettings', 'localSettings'])
    expect(getProjectMcpConfigsFromCwd()).toEqual({ servers: {}, errors: [] })
  })
})

describe('getMcpConfigByName', () => {
  function everywhere(name: string): void {
    writeManagedMcp({ mcpServers: { [name]: { command: 'from-enterprise' } } })
    setLocalServers({ [name]: { command: 'from-local' } })
    writeMcpJson({ mcpServers: { [name]: { command: 'from-project' } } })
    setUserServers({ [name]: { command: 'from-user' } })
  }

  test('precedence: enterprise, then local, then project, then user', () => {
    everywhere('dup')
    const winners: string[] = []
    const peel = [
      () => writeManagedMcp({ mcpServers: {} }),
      () => setLocalServers({}),
      () => writeMcpJson({ mcpServers: {} }),
      () => setUserServers({}),
    ]
    for (const remove of peel) {
      const hit = getMcpConfigByName('dup') as { command?: string; scope?: string } | null
      winners.push(hit ? `${hit.scope}:${hit.command}` : 'none')
      remove()
    }
    winners.push(String(getMcpConfigByName('dup')))
    expect(winners).toEqual(['enterprise:from-enterprise', 'local:from-local', 'project:from-project', 'user:from-user', 'null'])
  })

  test('a project server nobody approved is still returned by name', () => {
    writeMcpJson({ mcpServers: { unapproved: { command: 'x' } } })
    writeSettings('local', { disabledMcpjsonServers: ['unapproved'] })
    expect(getMcpConfigByName('unapproved')).toEqual({ ...stdio('x'), scope: 'project' })
  })

  test('neither the policy nor the disabled list hides a server from the lookup', () => {
    setUserServers({ denied: { command: 'd' }, off: { command: 'o' } })
    writeSettings('policy', { deniedMcpServers: [{ serverName: 'denied' }], allowedMcpServers: [] })
    setToggles({ disabled: ['off'] })
    expect([getMcpConfigByName('denied'), getMcpConfigByName('off')]).toEqual([
      { ...stdio('d'), scope: 'user' },
      { ...stdio('o'), scope: 'user' },
    ])
  })

  test('the managed plugin-only lock leaves only enterprise servers reachable', () => {
    everywhere('dup')
    setUserServers({ dup: { command: 'from-user' }, mine: { command: 'm' } })
    writeSettings('policy', { strictPluginOnlyCustomization: ['mcp'] })
    writeManagedMcp({ mcpServers: { org: { command: 'o' } } })
    expect([getMcpConfigByName('org'), getMcpConfigByName('mine'), getMcpConfigByName('dup')]).toEqual([
      { ...stdio('o'), scope: 'enterprise' },
      null,
      null,
    ])
  })
})
