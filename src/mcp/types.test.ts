import { describe, expect, test } from 'bun:test'
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
  type McpHTTPServerConfig,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type McpWebSocketServerConfig,
} from 'src/mcp/types.js'

describe('config scopes and transports', () => {
  test('the scopes a server config can come from', () => {
    expect(ConfigScopeSchema().options).toEqual([
      'local',
      'user',
      'project',
      'dynamic',
      'enterprise',
      'claudeai',
      'managed',
    ])
  })

  test('the transport names', () => {
    expect(TransportSchema().options).toEqual(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk'])
  })
})

describe('stdio server config', () => {
  test('type is optional and args default to an empty list', () => {
    expect(McpStdioServerConfigSchema().parse({ command: 'npx' })).toEqual({
      command: 'npx',
      args: [],
    })
  })

  test('keeps args and env', () => {
    const config: McpStdioServerConfig = { type: 'stdio', command: 'node', args: ['srv.js'], env: { A: '1' } }
    expect(McpStdioServerConfigSchema().parse(config)).toEqual(config)
  })

  test('an empty command is refused with its message', () => {
    const result = McpStdioServerConfigSchema().safeParse({ command: '' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Command cannot be empty')
  })

  test('keeps a cwd and the per-server timeouts', () => {
    const config: McpStdioServerConfig = {
      command: 'npx',
      args: [],
      cwd: '~/tools/slow',
      startupTimeout: 60_000,
      toolTimeout: 900_000,
    }
    expect(McpStdioServerConfigSchema().parse(config)).toEqual(config)
    expect(McpStdioServerConfigSchema().safeParse({ command: 'npx', cwd: '' }).success).toBe(false)
  })
})

describe('per-server timeouts', () => {
  test('the remote types take them too', () => {
    const timeouts = { startupTimeout: 1, toolTimeout: 2 }
    expect(McpSSEServerConfigSchema().parse({ type: 'sse', url: 'u', ...timeouts })).toMatchObject(timeouts)
    expect(McpHTTPServerConfigSchema().parse({ type: 'http', url: 'u', ...timeouts })).toMatchObject(timeouts)
    expect(McpWebSocketServerConfigSchema().parse({ type: 'ws', url: 'u', ...timeouts })).toMatchObject(timeouts)
  })

  test('must be positive whole milliseconds', () => {
    for (const value of [0, -1, 1.5, '60000']) {
      expect(McpStdioServerConfigSchema().safeParse({ command: 'npx', startupTimeout: value }).success).toBe(false)
      expect(McpHTTPServerConfigSchema().safeParse({ type: 'http', url: 'u', toolTimeout: value }).success).toBe(false)
    }
  })
})

describe('remote server configs', () => {
  test('sse keeps headers, headersHelper and oauth', () => {
    const config: McpSSEServerConfig = {
      type: 'sse',
      url: 'https://srv/sse',
      headers: { 'X-A': '1' },
      headersHelper: 'print-headers',
      oauth: { clientId: 'cid', callbackPort: 8765, authServerMetadataUrl: 'https://auth/.well-known' },
    }
    expect(McpSSEServerConfigSchema().parse(config)).toEqual(config)
  })

  test('http keeps the same fields', () => {
    const config: McpHTTPServerConfig = { type: 'http', url: 'https://srv/mcp', oauth: { clientId: 'cid' } }
    expect(McpHTTPServerConfigSchema().parse(config)).toEqual(config)
  })

  test('an oauth metadata URL must be https', () => {
    const result = McpHTTPServerConfigSchema().safeParse({
      type: 'http',
      url: 'https://srv/mcp',
      oauth: { authServerMetadataUrl: 'http://auth/.well-known' },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(i => i.message)).toContain('authServerMetadataUrl must use https://')
  })

  test('an oauth callback port must be a positive integer', () => {
    for (const callbackPort of [0, -1, 1.5]) {
      expect(
        McpSSEServerConfigSchema().safeParse({ type: 'sse', url: 'u', oauth: { callbackPort } }).success,
      ).toBe(false)
    }
  })

  test('ws keeps headers and headersHelper', () => {
    const config: McpWebSocketServerConfig = { type: 'ws', url: 'wss://srv/ws', headers: { 'X-A': '1' }, headersHelper: 'h' }
    expect(McpWebSocketServerConfigSchema().parse(config)).toEqual(config)
  })
})

describe('internal server configs', () => {
  test('sse-ide and ws-ide carry the IDE name', () => {
    expect(
      McpSSEIDEServerConfigSchema().parse({ type: 'sse-ide', url: 'u', ideName: 'vscode', ideRunningInWindows: true }),
    ).toEqual({ type: 'sse-ide', url: 'u', ideName: 'vscode', ideRunningInWindows: true })
    expect(
      McpWebSocketIDEServerConfigSchema().parse({ type: 'ws-ide', url: 'u', ideName: 'zed', authToken: 't' }),
    ).toEqual({ type: 'ws-ide', url: 'u', ideName: 'zed', authToken: 't' })
  })

  test('sdk and claude.ai proxy configs', () => {
    expect(McpSdkServerConfigSchema().parse({ type: 'sdk', name: 'in-proc' })).toEqual({ type: 'sdk', name: 'in-proc' })
    expect(
      McpClaudeAIProxyServerConfigSchema().parse({ type: 'claudeai-proxy', url: 'u', id: 'srv_1' }),
    ).toEqual({ type: 'claudeai-proxy', url: 'u', id: 'srv_1' })
  })
})

describe('McpServerConfigSchema', () => {
  test('accepts every server type', () => {
    for (const config of [
      { command: 'npx' },
      { type: 'sse', url: 'u' },
      { type: 'sse-ide', url: 'u', ideName: 'i' },
      { type: 'ws-ide', url: 'u', ideName: 'i' },
      { type: 'http', url: 'u' },
      { type: 'ws', url: 'u' },
      { type: 'sdk', name: 'n' },
      { type: 'claudeai-proxy', url: 'u', id: 'i' },
    ]) {
      expect(McpServerConfigSchema().safeParse(config).success).toBe(true)
    }
  })

  test('refuses an unknown type', () => {
    expect(McpServerConfigSchema().safeParse({ type: 'grpc', url: 'u' }).success).toBe(false)
  })

  test('.mcp.json maps names to server configs', () => {
    const parsed = McpJsonConfigSchema().parse({
      mcpServers: { a: { command: 'npx' }, b: { type: 'http', url: 'u' } },
    })
    expect(Object.keys(parsed.mcpServers)).toEqual(['a', 'b'])
    expect(McpJsonConfigSchema().safeParse({ mcpServers: { a: { type: 'http' } } }).success).toBe(false)
  })
})
