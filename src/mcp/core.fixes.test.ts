/**
 * mcp/core decisions the characterization suites do not pin: the spec's fix
 * (finding 4) and the edges of the rewritten helpers.
 */
import { describe, expect, test } from 'bun:test'
import { getMcpInstructionsDelta } from 'src/mcp/mcpInstructionsDelta.js'
import { McpHTTPServerConfigSchema, McpStdioServerConfigSchema } from 'src/mcp/types.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { extractAgentMcpServers, getLoggingSafeMcpBaseUrl, parseHeaders } from 'src/mcp/utils.js'
import { parseAgentsFromJson } from 'src/tools/AgentTool/loadAgentsDir.js'

describe('finding 4: the logging-safe URL drops credentials', () => {
  const cases: Array<[label: string, config: object, out: string | undefined]> = [
    ['user and password', { type: 'http', url: 'https://user:pw@h.example/mcp?t=1' }, 'https://h.example/mcp'],
    ['a user alone', { type: 'sse', url: 'https://token@h.example/sse/' }, 'https://h.example/sse'],
    ['a password alone', { type: 'ws', url: 'wss://:pw@h.example/ws' }, 'wss://h.example/ws'],
    ['a bare origin with credentials', { type: 'http', url: 'https://u:p@h.example' }, 'https://h.example'],
    ['credentials and a fragment', { type: 'http', url: 'https://u:p@h.example/p#frag' }, 'https://h.example/p#frag'],
    ['an IDE server', { type: 'sse-ide', url: 'http://u:p@127.0.0.1:9/sse', ideName: 'x' }, 'http://127.0.0.1:9/sse'],
  ]
  test.each(cases)('%s', (_label, config, out) => {
    const safe = getLoggingSafeMcpBaseUrl(config as never)
    expect(safe).toBe(out)
    expect(safe).not.toContain('@')
  })
})

describe('edges of the rewritten helpers', () => {
  test('a header named __proto__ is an own key, not the prototype', () => {
    const headers = parseHeaders(['__proto__: x'])
    expect(Object.keys(headers)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype)
  })

  test('the default argument list is a fresh array on every parse', () => {
    const a = McpStdioServerConfigSchema().parse({ command: 'x' })
    const b = McpStdioServerConfigSchema().parse({ command: 'x' })
    expect(a.args).toEqual([])
    expect(a.args).not.toBe(b.args)
  })

  test.each(['https://', 'https://exa mple.com'])('an https metadata value that is not a URL is refused: %p', bad => {
    const parsed = McpHTTPServerConfigSchema().safeParse({ type: 'http', url: 'https://h', oauth: { authServerMetadataUrl: bad } })
    expect(parsed.success).toBe(false)
  })

  test('a one-character server reference is a name, not an inline entry', () => {
    const agents = parseAgentsFromJson({ a: { description: 'd', prompt: 'p', mcpServers: ['x'] } })
    expect(extractAgentMcpServers(agents)).toEqual([])
  })

  test('a client-side block reaches only the server it names', () => {
    const connected = (name: string, instructions: string): MCPServerConnection =>
      ({ name, type: 'connected', instructions, config: { command: 'x', args: [], scope: 'local' } }) as unknown as MCPServerConnection
    const delta = getMcpInstructionsDelta([connected('a', 'A.'), connected('b', 'B.')], [], [{ serverName: 'b', block: 'extra' }])
    expect(delta?.addedBlocks).toEqual(['## a\nA.', '## b\nB.\n\nextra'])
  })
})
