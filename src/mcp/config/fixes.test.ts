/**
 * The "fix" decisions of the mcp/config spec (docs/tech/rewrite/mcp/config.md,
 * Findings 1-4, 10 and 13), each driven through the public exports.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getPlatform } from 'src/shared/proc/platform.js'
import { addMcpConfig, filterMcpServersByPolicy, parseMcpConfig, removeMcpConfig } from 'src/mcp/config.js'
import {
  enterWorld,
  leaveWorld,
  userServersOnRecord,
  withEnv,
  writeMcpJson,
  writeSettings,
  type Json,
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
  getPlatform.cache.delete(undefined)
  leaveWorld()
})

const fileText = () => readFileSync(join(w.project, '.mcp.json'), 'utf8')

describe('Finding 1: a project write keeps the other entries as written', () => {
  const existing = {
    $schema: 'https://example.test/mcp.schema.json',
    mcpServers: {
      api: { type: 'http', url: 'https://${CHAR_FIX_HOST}/mcp', headers: { Authorization: 'Bearer ${CHAR_FIX_TOKEN}' }, note: 'kept' },
      tool: { command: '${CHAR_FIX_BIN}', env: { KEY: '${CHAR_FIX_TOKEN}' } },
    },
  }

  test.each([
    ['adding a server', () => addMcpConfig('extra', { command: 'e' }, 'project'), { extra: { command: 'e', args: [] } }],
    ['removing a server', () => removeMcpConfig('tool', 'project'), null],
  ] as const)('%s', async (_why, act, added) => {
    undoEnv = withEnv({ CHAR_FIX_HOST: 'mcp.example.com', CHAR_FIX_TOKEN: 'secret-value', CHAR_FIX_BIN: '/opt/bin/tool' })
    writeMcpJson(existing)
    await act()
    const written = fileText()
    expect(written).not.toContain('secret-value')
    expect(written).not.toContain('/opt/bin/tool')
    const servers: Json = added ? { ...existing.mcpServers, ...added } : { api: existing.mcpServers.api }
    expect(JSON.parse(written)).toEqual({ $schema: existing.$schema, mcpServers: servers })
  })
})

describe('Finding 2: adding to an unusable .mcp.json leaves it alone', () => {
  test.each([
    ['not JSON', '{"mcpServers": {"a": '],
    ['off the schema', JSON.stringify({ mcpServers: { a: { type: 'ws' }, b: { command: 'b' } } })],
  ])('%s', async (_why, text) => {
    writeMcpJson(text)
    const err = (await addMcpConfig('fresh', { command: 'f' }, 'project').catch((e: Error) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('.mcp.json')
    expect(err.message).toContain('left unchanged')
    expect(fileText()).toBe(text)
  })
})

describe('Finding 3: an empty server name is refused', () => {
  test.each(['user', 'local', 'project'] as const)('%s', async scope => {
    await expect(addMcpConfig('', { command: 'x' }, scope)).rejects.toThrow('Invalid name: a server name cannot be empty.')
    expect(userServersOnRecord()).toBeUndefined()
  })
})

describe('Finding 4: a config no transport accepts gets a clear error', () => {
  test.each([
    ['a remote type without its url', { type: 'sse' }],
    ['not an object', 'node server.js'],
  ])('%s', async (_why, config) => {
    const err = (await addMcpConfig('x', config, 'user').catch((e: Error) => e)) as Error
    expect(err.message.startsWith('Invalid configuration: Invalid input: matches no MCP transport')).toBe(true)
    expect(err.message).not.toContain(': : ')
    for (const type of ['stdio', 'sse', 'http', 'ws', 'sdk', 'claudeai-proxy']) expect(err.message).toContain(type)
  })

  test('a field-level issue still names its field', async () => {
    await expect(addMcpConfig('x', { command: '' }, 'user')).rejects.toThrow('Invalid configuration: command: Command cannot be empty')
  })
})

describe('Finding 10: URL patterns ignore the case of the scheme and host', () => {
  type Row = [why: string, list: 'deniedMcpServers' | 'allowedMcpServers', pattern: string, url: string, allowed: boolean]
  const rows: Row[] = [
    ['a deny catches an upper-case host', 'deniedMcpServers', 'https://mcp.example.com/*', 'https://MCP.example.com/x', false],
    ['a deny catches an upper-case scheme', 'deniedMcpServers', 'https://mcp.example.com/*', 'HTTPS://mcp.example.com/x', false],
    ['a pattern written in upper case catches a lower-case host', 'deniedMcpServers', 'https://MCP.Example.COM/*', 'https://mcp.example.com/x', false],
    ['the path stays case-sensitive', 'deniedMcpServers', 'https://h.example/Admin', 'https://h.example/admin', true],
    ['an allow entry admits the same host in another case', 'allowedMcpServers', 'https://*.example.com/*', 'https://Tools.EXAMPLE.com/mcp', true],
    ['an allow entry still refuses another host', 'allowedMcpServers', 'https://*.example.com/*', 'https://example.org/mcp', false],
  ]

  test.each(rows)('%s', (_why, list, pattern, url, allowed) => {
    writeSettings('policy', { [list]: [{ serverUrl: pattern }] })
    const { blocked } = filterMcpServersByPolicy({ srv: { type: 'http', url } })
    expect(blocked.length === 0).toBe(allowed)
  })
})

describe('Finding 13: the Windows npx hint links to no other product', () => {
  test('neither the message nor the suggestion carries a link', () => {
    getPlatform.cache.set(undefined, 'windows')
    const { errors } = parseMcpConfig({ configObject: { mcpServers: { w: { command: 'npx' } } }, expandVars: true, scope: 'user' })
    expect(errors).toHaveLength(1)
    const text = `${errors[0]!.message} ${errors[0]!.suggestion}`
    expect(text).not.toContain('code.claude.com')
    expect(text).not.toMatch(/https?:\/\//)
    expect(errors[0]!.docLink).toBeUndefined()
  })
})
