/**
 * Characterization of MCP config parsing (src/mcp/config.ts):
 * `parseMcpConfig` and `parseMcpConfigFromFilePath`.
 *
 * Error objects are a contract: `mcp doctor` keys on the message text
 * ('Missing environment variables:' as a prefix, the schema message exactly),
 * the settings error list shows `file`/`path`/`suggestion`, and
 * `mcpErrorMetadata` decides fatal versus warning.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getPlatform } from 'src/shared/proc/platform.js'
import { parseMcpConfig, parseMcpConfigFromFilePath } from 'src/mcp/config.js'
import type { ConfigScope } from 'src/mcp/types.js'
import { enterWorld, leaveWorld, withEnv, writeMcpJson, type World } from 'src/mcp/__testutils__/mcpConfigWorld.js'

const SCHEMA_MSG = 'Does not adhere to MCP server configuration schema'
const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

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

function parse(configObject: unknown, opts: { expandVars?: boolean; scope?: ConfigScope; filePath?: string } = {}) {
  return parseMcpConfig({ configObject, expandVars: opts.expandVars ?? true, scope: opts.scope ?? 'user', filePath: opts.filePath })
}

describe('parseMcpConfig: valid input', () => {
  test('every transport shape is accepted, and stdio gains an empty args list', () => {
    const servers = {
      bare: { command: 'node' },
      typed: { type: 'stdio', command: 'node', args: ['s.js'], env: { K: 'v' } },
      sse: { type: 'sse', url: 'https://h/sse', headers: { A: 'b' }, headersHelper: './h.sh' },
      http: { type: 'http', url: 'https://h/mcp', oauth: { clientId: 'c', callbackPort: 7777 } },
      ws: { type: 'ws', url: 'wss://h/ws' },
      sdk: { type: 'sdk', name: 'in-process' },
      ide: { type: 'sse-ide', url: 'http://127.0.0.1:1/sse', ideName: 'vscode' },
      wside: { type: 'ws-ide', url: 'ws://127.0.0.1:1', ideName: 'jb', authToken: 't' },
      proxy: { type: 'claudeai-proxy', url: 'https://p', id: 'srv_1' },
    }
    const { config, errors } = parse({ mcpServers: servers })
    expect(errors).toEqual([])
    expect(config).toEqual({
      mcpServers: { ...servers, bare: { command: 'node', args: [] } } as never,
    })
  })

  test('unknown keys are dropped, on a server and beside mcpServers', () => {
    const { config } = parse({ $schema: 'x', mcpServers: { a: { command: 'c', note: 'dropped' } } })
    expect(config).toEqual({ mcpServers: { a: { command: 'c', args: [] } } })
  })

  test('an empty server map is a valid config', () => {
    expect(parse({ mcpServers: {} })).toEqual({ config: { mcpServers: {} }, errors: [] })
  })
})

describe('parseMcpConfig: schema errors', () => {
  type Bad = [why: string, input: unknown, paths: string[]]
  const bad: Bad[] = [
    ['not an object', [], ['']],
    ['no mcpServers key', { servers: {} }, ['mcpServers']],
    ['an unknown transport', { mcpServers: { a: { type: 'smoke', url: 'u' } } }, ['mcpServers.a']],
    ['an empty command', { mcpServers: { a: { command: '' } } }, ['mcpServers.a.command']],
    ['a remote server without url', { mcpServers: { a: { type: 'http' } } }, ['mcpServers.a']],
    ['oauth metadata over http', { mcpServers: { a: { type: 'http', url: 'u', oauth: { authServerMetadataUrl: 'http://x/y' } } } }, ['mcpServers.a.oauth.authServerMetadataUrl']],
    ['two broken servers, one error each', { mcpServers: { a: { command: 1 }, ok: { command: 'x' }, b: { type: 'ws' } } }, ['mcpServers.a', 'mcpServers.b']],
  ]

  test.each(bad)('%s: no config, one fatal error per issue', (_why, input, paths) => {
    const { config, errors } = parse(input, { scope: 'local' })
    expect(config).toBeNull()
    expect(errors).toEqual(
      paths.map(path => ({ path, message: SCHEMA_MSG, mcpErrorMetadata: { scope: 'local', severity: 'fatal' } })),
    )
  })

  test('the file path, when given, is stamped on every error', () => {
    const { errors } = parse({ mcpServers: { a: {} } }, { filePath: 'command line', scope: 'dynamic' })
    expect(errors.map(e => [e.file, e.mcpErrorMetadata?.scope])).toEqual([['command line', 'dynamic']])
  })

  test('one invalid server rejects the whole config', () => {
    expect(parse({ mcpServers: { good: { command: 'x' }, broken: { type: 'sse' } } }).config).toBeNull()
  })
})

describe('parseMcpConfig: environment expansion', () => {
  test('stdio command, args and env values are expanded; keys and other fields are not', () => {
    undoEnv = withEnv({ CHAR_MCP_BIN: '/opt/bin/srv', CHAR_MCP_ARG: '--fast', CHAR_MCP_TOKEN: 'tok' })
    const { config, errors } = parse({
      mcpServers: {
        s: { command: '${CHAR_MCP_BIN}', args: ['${CHAR_MCP_ARG}', 'lit'], env: { '${CHAR_MCP_ARG}': 'Bearer ${CHAR_MCP_TOKEN}' } },
      },
    })
    expect(errors).toEqual([])
    expect(config?.mcpServers.s).toEqual({ command: '/opt/bin/srv', args: ['--fast', 'lit'], env: { '${CHAR_MCP_ARG}': 'Bearer tok' } })
  })

  test.each(['sse', 'http', 'ws'] as const)('%s: url and header values are expanded; headersHelper and oauth are not', type => {
    undoEnv = withEnv({ CHAR_MCP_HOST: 'mcp.example.com', CHAR_MCP_TOKEN: 'tok' })
    const extra = type === 'ws' ? {} : { oauth: { clientId: '${CHAR_MCP_TOKEN}' } }
    const { config } = parse({
      mcpServers: {
        r: { type, url: 'https://${CHAR_MCP_HOST}/x', headers: { Authorization: 'Bearer ${CHAR_MCP_TOKEN}' }, headersHelper: '${CHAR_MCP_TOKEN}.sh', ...extra },
      },
    })
    expect(config?.mcpServers.r).toEqual({
      type,
      url: 'https://mcp.example.com/x',
      headers: { Authorization: 'Bearer tok' },
      headersHelper: '${CHAR_MCP_TOKEN}.sh',
      ...extra,
    } as never)
  })

  test('IDE, SDK and claude.ai proxy entries are never expanded', () => {
    undoEnv = withEnv({ CHAR_MCP_HOST: 'expanded' })
    const servers = {
      i: { type: 'sse-ide', url: 'http://${CHAR_MCP_HOST}', ideName: 'x' },
      j: { type: 'ws-ide', url: 'ws://${CHAR_MCP_HOST}', ideName: 'x' },
      k: { type: 'sdk', name: '${CHAR_MCP_HOST}' },
      p: { type: 'claudeai-proxy', url: 'https://${CHAR_MCP_HOST}', id: '${CHAR_MCP_HOST}' },
    }
    expect(parse({ mcpServers: servers })).toEqual({ config: { mcpServers: servers as never }, errors: [] })
  })

  test('missing variables keep the server, verbatim, with one warning per server listing each name once', () => {
    undoEnv = withEnv({ CHAR_MCP_A: undefined, CHAR_MCP_B: undefined })
    const raw = { command: '${CHAR_MCP_A}', args: ['${CHAR_MCP_B}', '${CHAR_MCP_A}'] }
    const { config, errors } = parse({ mcpServers: { s: raw, t: { type: 'http', url: '${CHAR_MCP_B}' } } }, { scope: 'project', filePath: '/p/.mcp.json' })
    expect(config?.mcpServers.s).toEqual(raw)
    expect(errors).toEqual([
      {
        file: '/p/.mcp.json',
        path: 'mcpServers.s',
        message: 'Missing environment variables: CHAR_MCP_A, CHAR_MCP_B',
        suggestion: 'Set the following environment variables: CHAR_MCP_A, CHAR_MCP_B',
        mcpErrorMetadata: { scope: 'project', serverName: 's', severity: 'warning' },
      },
      {
        file: '/p/.mcp.json',
        path: 'mcpServers.t',
        message: 'Missing environment variables: CHAR_MCP_B',
        suggestion: 'Set the following environment variables: CHAR_MCP_B',
        mcpErrorMetadata: { scope: 'project', serverName: 't', severity: 'warning' },
      },
    ])
  })

  test('with expandVars off nothing is substituted and nothing is reported', () => {
    undoEnv = withEnv({ CHAR_MCP_A: 'set', CHAR_MCP_GONE: undefined })
    const raw = { command: '${CHAR_MCP_A}', args: ['${CHAR_MCP_GONE}'] }
    expect(parse({ mcpServers: { s: raw } }, { expandVars: false })).toEqual({ config: { mcpServers: { s: raw } }, errors: [] })
  })
})

describe('parseMcpConfig: the Windows npx warning', () => {
  type Row = [command: string, type: string | undefined, warns: boolean]
  const rows: Row[] = [
    ['npx', undefined, true],
    ['npx', 'stdio', true],
    ['C:\\tools\\npx', undefined, true],
    ['/usr/local/bin/npx', undefined, true],
    ['${CHAR_MCP_NPX}', undefined, true],
    ['npx.cmd', undefined, false],
    ['cmd', undefined, false],
    ['mynpx-wrapper', undefined, false],
  ]

  test.each(rows)('command %p (type %p) warns: %p', (command, type, warns) => {
    getPlatform.cache.set(undefined, 'windows')
    undoEnv = withEnv({ CHAR_MCP_NPX: 'npx' })
    const server = { command, args: ['-y', 'pkg'], ...(type ? { type } : {}) }
    const { config, errors } = parse({ mcpServers: { w: server } }, { scope: 'local', filePath: 'f' })
    expect(config?.mcpServers.w).toBeDefined()
    if (!warns) {
      expect(errors).toEqual([])
      return
    }
    expect(errors).toHaveLength(1)
    const [e] = errors
    expect([e!.file, e!.path, e!.mcpErrorMetadata]).toEqual(['f', 'mcpServers.w', { scope: 'local', serverName: 'w', severity: 'warning' }])
    expect(e!.message).toContain("'cmd /c'")
    expect(e!.message).toContain('npx')
    expect(e!.suggestion).toContain('"cmd"')
    expect(e!.suggestion).toContain('["/c", "npx", ...]')
  })

  test('remote servers never warn, and nothing warns off Windows', () => {
    getPlatform.cache.set(undefined, 'windows')
    expect(parse({ mcpServers: { r: { type: 'http', url: 'npx' } } }).errors).toEqual([])
    getPlatform.cache.set(undefined, 'linux')
    expect(parse({ mcpServers: { s: { command: 'npx' } } }).errors).toEqual([])
  })
})

describe('parseMcpConfigFromFilePath', () => {
  const at = (path: string, scope: ConfigScope = 'project') => parseMcpConfigFromFilePath({ filePath: path, expandVars: true, scope })

  test('a missing file: fatal, with the path in the message', () => {
    const path = join(w.project, 'absent.json')
    expect(at(path, 'enterprise')).toEqual({
      config: null,
      errors: [
        {
          file: path,
          path: '',
          message: `MCP config file not found: ${path}`,
          suggestion: 'Check that the file path is correct',
          mcpErrorMetadata: { scope: 'enterprise', severity: 'fatal' },
        },
      ],
    })
  })

  test('a path that cannot be read: fatal, with the system error in the message', () => {
    const { config, errors } = at(w.project, 'dynamic')
    expect(config).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message.startsWith('Failed to read file: ')).toBe(true)
    expect(errors[0]!.message).toContain('EISDIR')
    expect(errors[0]).toMatchObject({
      file: w.project,
      path: '',
      suggestion: 'Check file permissions and ensure the file exists',
      mcpErrorMetadata: { scope: 'dynamic', severity: 'fatal' },
    })
  })

  test('a file without read permission: fatal read error', () => {
    if (process.getuid?.() === 0) return
    const path = writeMcpJson({ mcpServers: {} })
    chmodSync(path, 0o000)
    expect(at(path).errors[0]!.message).toContain('EACCES')
  })

  test.each([
    ['not JSON', '{mcpServers'],
    ['empty', ''],
    ['JSON with a comment', '{"mcpServers":{} // note\n}'],
    ['a trailing comma', '{"mcpServers":{},}'],
    ['the literal null', 'null'],
    ['the literal false', 'false'],
  ])('%s: "not a valid JSON"', (_why, text) => {
    const path = writeMcpJson(text)
    expect(at(path, 'local')).toEqual({
      config: null,
      errors: [
        {
          file: path,
          path: '',
          message: 'MCP config is not a valid JSON',
          suggestion: 'Fix the JSON syntax errors in the file',
          mcpErrorMetadata: { scope: 'local', severity: 'fatal' },
        },
      ],
    })
  })

  test('a byte-order mark is tolerated', () => {
    const path = writeMcpJson('\uFEFF{"mcpServers":{"a":{"command":"x"}}}')
    expect(at(path)).toEqual({ config: { mcpServers: { a: { command: 'x', args: [] } } }, errors: [] })
  })

  test('valid JSON goes through the schema, with the file on each error', () => {
    const path = writeMcpJson({ mcpServers: { a: { type: 'ws' } } })
    expect(at(path).errors).toEqual([{ file: path, path: 'mcpServers.a', message: SCHEMA_MSG, mcpErrorMetadata: { scope: 'project', severity: 'fatal' } }])
  })

  test('the fixture file in the documented format parses to the documented servers', () => {
    undoEnv = withEnv({ CHAR_MCP_FIXTURE_TOKEN: 'abc' })
    mkdirSync(w.project, { recursive: true })
    const path = writeMcpJson(readFileSync(join(FIXTURES, 'config-scopes.mcp.json'), 'utf8'))
    expect(at(path)).toEqual({
      config: {
        mcpServers: {
          files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], env: { LOG_LEVEL: 'info' } },
          tracker: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer abc' } },
          events: { type: 'sse', url: 'https://events.example.com/sse' },
        },
      },
      errors: [],
    })
  })
})
