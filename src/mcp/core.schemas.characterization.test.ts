/**
 * mcp/core, part 2: the server configuration contract.
 *
 * The zod schemas exported from src/mcp/types.ts decide which server entries
 * of a `.mcp.json`, a settings file, a plugin manifest or an agent definition
 * are accepted, and what the accepted value looks like afterwards (defaults
 * filled in, unknown keys dropped). Each schema is driven with real config
 * objects and pinned on both sides: what it accepts and what it refuses.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  ConfigScopeSchema,
  McpClaudeAIProxyServerConfigSchema,
  McpHTTPServerConfigSchema,
  McpJsonConfigSchema,
  McpSdkServerConfigSchema,
  McpServerConfigSchema,
  McpSSEIDEServerConfigSchema,
  McpSSEServerConfigSchema,
  McpStdioServerConfigSchema,
  McpWebSocketIDEServerConfigSchema,
  McpWebSocketServerConfigSchema,
  TransportSchema,
} from 'src/mcp/types.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const readFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

type Schema = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ message: string; path: PropertyKey[] }> } } }

function accepted(schema: Schema, value: unknown): unknown {
  const r = schema.safeParse(value)
  if (!r.success) throw new Error(`refused: ${JSON.stringify(r.error?.issues)}`)
  return r.data
}

function refusal(schema: Schema, value: unknown): string[] {
  const r = schema.safeParse(value)
  expect(r.success).toBe(false)
  return (r.error?.issues ?? []).map(i => i.message)
}

describe('enumerations', () => {
  test('the config scopes, in order', () => {
    expect(ConfigScopeSchema().options).toEqual(['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed'])
  })

  test('the transports, in order; the two IDE-only and the proxy types are not listed', () => {
    expect(TransportSchema().options).toEqual(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk'])
    for (const t of ['ws-ide', 'claudeai-proxy', 'STDIO', '']) expect(TransportSchema().safeParse(t).success).toBe(false)
  })

  test('a schema getter hands back the same schema each time', () => {
    expect(McpServerConfigSchema()).toBe(McpServerConfigSchema())
    expect(ConfigScopeSchema()).toBe(ConfigScopeSchema())
  })
})

describe('a .mcp.json file', () => {
  test('parses to the pinned value: defaults filled, unknown keys dropped', () => {
    expect(accepted(McpJsonConfigSchema(), readFixture('project.mcp.json'))).toEqual(readFixture('project.mcp.parsed.json'))
  })

  test('an empty server map is valid', () => {
    expect(accepted(McpJsonConfigSchema(), { mcpServers: {} })).toEqual({ mcpServers: {} })
  })

  const bad: Array<[label: string, value: unknown]> = [
    ['no mcpServers key', {}],
    ['mcpServers is a list', { mcpServers: [] }],
    ['one bad entry spoils the file', { mcpServers: { ok: { command: 'x' }, bad: { type: 'http' } } }],
    ['not an object', 'mcpServers'],
  ]
  test.each(bad)('refuses %s', (_label, value) => {
    expect(McpJsonConfigSchema().safeParse(value).success).toBe(false)
  })
})

describe('stdio', () => {
  const ok: Array<[label: string, input: object, out: object]> = [
    ['type may be omitted', { command: 'node' }, { command: 'node', args: [] }],
    ['explicit type', { type: 'stdio', command: 'node', args: ['s.js'] }, { type: 'stdio', command: 'node', args: ['s.js'] }],
    ['env is kept as given', { command: 'node', env: { A: '1', EMPTY: '' } }, { command: 'node', args: [], env: { A: '1', EMPTY: '' } }],
    ['a command that is only whitespace is still a command', { command: ' ' }, { command: ' ', args: [] }],
    ['unknown keys are dropped', { command: 'node', cwd: '/tmp', url: 'http://x' }, { command: 'node', args: [] }],
  ]
  test.each(ok)('accepts: %s', (_label, input, out) => {
    expect(accepted(McpStdioServerConfigSchema(), input)).toEqual(out)
  })

  test('an empty command is refused with its own message', () => {
    expect(refusal(McpStdioServerConfigSchema(), { command: '' })).toEqual(['Command cannot be empty'])
  })

  const bad: Array<[label: string, input: object]> = [
    ['no command', { args: [] }],
    ['a command that is not a string', { command: ['node'] }],
    ['an argument that is not a string', { command: 'node', args: [1] }],
    ['an env value that is not a string', { command: 'node', env: { PORT: 8080 } }],
    ['another type', { type: 'http', command: 'node' }],
  ]
  test.each(bad)('refuses %s', (_label, input) => {
    expect(McpStdioServerConfigSchema().safeParse(input).success).toBe(false)
  })
})

describe('remote transports: sse, http, ws', () => {
  const remote: Array<[type: string, schema: () => Schema, takesOAuth: boolean]> = [
    ['sse', McpSSEServerConfigSchema as () => Schema, true],
    ['http', McpHTTPServerConfigSchema as () => Schema, true],
    ['ws', McpWebSocketServerConfigSchema as () => Schema, false],
  ]

  test.each(remote)('%s keeps url, headers and headersHelper', (type, schema) => {
    const input = { type, url: 'https://h.example/mcp', headers: { 'X-A': 'b' }, headersHelper: 'print-headers' }
    expect(accepted(schema(), input)).toEqual(input)
  })

  test.each(remote)('%s: the url is not checked to be a URL', (type, schema) => {
    expect(accepted(schema(), { type, url: 'not a url' })).toEqual({ type, url: 'not a url' })
  })

  test.each(remote)('%s refuses a missing url, a missing or wrong type, and a non-string header', (type, schema) => {
    for (const input of [{ type }, { url: 'https://h' }, { type: 'stdio', url: 'https://h' }, { type, url: 'https://h', headers: { n: 1 } }]) {
      expect(schema().safeParse(input).success).toBe(false)
    }
  })

  test.each(remote)('%s and an oauth block (accepted: %p)', (type, schema, takesOAuth) => {
    const oauth = { clientId: 'cid', callbackPort: 7777 }
    const out = accepted(schema(), { type, url: 'https://h', oauth })
    expect(out).toEqual(takesOAuth ? { type, url: 'https://h', oauth } : { type, url: 'https://h' })
  })

  const oauthOk: object[] = [
    {},
    { clientId: 'x' },
    { callbackPort: 1 },
    { authServerMetadataUrl: 'https://as.example/.well-known/oauth-authorization-server' },
  ]
  test.each(oauthOk)('http accepts the oauth block %p', oauth => {
    expect(accepted(McpHTTPServerConfigSchema(), { type: 'http', url: 'https://h', oauth })).toEqual({ type: 'http', url: 'https://h', oauth })
  })

  const oauthBad: Array<[label: string, oauth: object, message: string | null]> = [
    ['a metadata URL over plain http', { authServerMetadataUrl: 'http://as.example/meta' }, 'authServerMetadataUrl must use https://'],
    ['a metadata URL that is not a URL', { authServerMetadataUrl: 'https//as.example' }, null],
    ['a zero callback port', { callbackPort: 0 }, null],
    ['a negative callback port', { callbackPort: -80 }, null],
    ['a fractional callback port', { callbackPort: 80.5 }, null],
    ['a callback port given as text', { callbackPort: '8080' }, null],
    ['a client id that is not text', { clientId: 42 }, null],
  ]
  test.each(oauthBad)('sse refuses an oauth block with %s', (_label, oauth, message) => {
    const messages = refusal(McpSSEServerConfigSchema(), { type: 'sse', url: 'https://h', oauth })
    if (message) expect(messages).toContain(message)
  })
})

describe('internal transports', () => {
  const ok: Array<[label: string, schema: () => Schema, input: object]> = [
    ['sse-ide', McpSSEIDEServerConfigSchema as () => Schema, { type: 'sse-ide', url: 'http://127.0.0.1:9/sse', ideName: 'VS Code', ideRunningInWindows: true }],
    ['ws-ide', McpWebSocketIDEServerConfigSchema as () => Schema, { type: 'ws-ide', url: 'ws://127.0.0.1:9', ideName: 'JetBrains', authToken: 't', ideRunningInWindows: false }],
    ['sdk', McpSdkServerConfigSchema as () => Schema, { type: 'sdk', name: 'in-process' }],
    ['claudeai-proxy', McpClaudeAIProxyServerConfigSchema as () => Schema, { type: 'claudeai-proxy', url: 'https://proxy', id: 'srv_1' }],
  ]
  test.each(ok)('%s round-trips its fields', (_label, schema, input) => {
    expect(accepted(schema(), input)).toEqual(input)
  })

  const bad: Array<[label: string, schema: () => Schema, input: object]> = [
    ['sse-ide without ideName', McpSSEIDEServerConfigSchema as () => Schema, { type: 'sse-ide', url: 'http://x' }],
    ['ws-ide without url', McpWebSocketIDEServerConfigSchema as () => Schema, { type: 'ws-ide', ideName: 'x' }],
    ['sdk without name', McpSdkServerConfigSchema as () => Schema, { type: 'sdk' }],
    ['claudeai-proxy without id', McpClaudeAIProxyServerConfigSchema as () => Schema, { type: 'claudeai-proxy', url: 'https://p' }],
  ]
  test.each(bad)('refuses %s', (_label, schema, input) => {
    expect(schema().safeParse(input).success).toBe(false)
  })
})

describe('any server entry', () => {
  const ok: Array<[label: string, input: object, out: object]> = [
    ['an untyped command is stdio', { command: 'srv' }, { command: 'srv', args: [] }],
    ['an untyped command with a url is still stdio, url dropped', { command: 'srv', url: 'https://h' }, { command: 'srv', args: [] }],
    ['http', { type: 'http', url: 'https://h' }, { type: 'http', url: 'https://h' }],
    ['sse', { type: 'sse', url: 'https://h' }, { type: 'sse', url: 'https://h' }],
    ['ws', { type: 'ws', url: 'wss://h' }, { type: 'ws', url: 'wss://h' }],
    ['sse-ide', { type: 'sse-ide', url: 'http://h', ideName: 'i' }, { type: 'sse-ide', url: 'http://h', ideName: 'i' }],
    ['ws-ide', { type: 'ws-ide', url: 'ws://h', ideName: 'i' }, { type: 'ws-ide', url: 'ws://h', ideName: 'i' }],
    ['sdk', { type: 'sdk', name: 'n' }, { type: 'sdk', name: 'n' }],
    ['claudeai-proxy', { type: 'claudeai-proxy', url: 'https://p', id: 'i' }, { type: 'claudeai-proxy', url: 'https://p', id: 'i' }],
  ]
  test.each(ok)('accepts %s', (_label, input, out) => {
    expect(accepted(McpServerConfigSchema(), input)).toEqual(out)
  })

  const bad: Array<[label: string, input: unknown]> = [
    ['an untyped url (no command)', { url: 'https://h' }],
    ['an unknown type', { type: 'grpc', url: 'https://h' }],
    ['http with a command but no url', { type: 'http', command: 'srv' }],
    ['streamable-http, which is not a type name here', { type: 'streamable-http', url: 'https://h' }],
    ['stdio with an empty command', { type: 'stdio', command: '' }],
    ['http with a plain-http metadata URL', { type: 'http', url: 'https://h', oauth: { authServerMetadataUrl: 'http://as' } }],
    ['null', null],
    ['a string', 'npx srv'],
  ]
  test.each(bad)('refuses %s', (_label, input) => {
    expect(McpServerConfigSchema().safeParse(input).success).toBe(false)
  })
})
