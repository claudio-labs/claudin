import { expect, test } from 'bun:test'

import {
  translateClaudeShapedServer,
  translateCodexServer,
  translateCursorServer,
  translateGeminiServer,
  translateOpencodeServer,
} from 'src/platform/import/translate/mcpServers.js'

function expectOk(translation: ReturnType<typeof translateCodexServer>) {
  if (!translation.ok) {
    throw new Error(`expected a translation, got: ${translation.reason}`)
  }
  return translation
}

test('a Claude-shaped stdio server keeps its command, args and env', () => {
  const result = expectOk(
    translateClaudeShapedServer({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '${GH}' },
    }),
  )
  expect(result.config).toEqual({
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: '${GH}' },
  })
})

test('a Claude-shaped stdio server with no args gets the schema default', () => {
  const result = expectOk(translateClaudeShapedServer({ command: 'my-server' }))
  expect(result.config).toEqual({ type: 'stdio', command: 'my-server', args: [] })
})

test('an explicit sse transport is preserved and produces no note', () => {
  const result = expectOk(
    translateClaudeShapedServer({ type: 'sse', url: 'https://x/sse' }),
  )
  expect(result.config).toEqual({ type: 'sse', url: 'https://x/sse' })
  expect(result.note).toBeUndefined()
})

test('a remote entry with no declared transport is imported as http, with a note', () => {
  const result = expectOk(
    translateClaudeShapedServer({ url: 'https://x/mcp' }),
  )
  expect(result.config).toEqual({ type: 'http', url: 'https://x/mcp' })
  expect(result.note).toContain('streamable HTTP')
})

test('an entry with neither command nor url is refused, not half-imported', () => {
  const result = translateClaudeShapedServer({ description: 'nothing here' })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('neither command nor url')
})

test('args that are not all strings refuse the whole server', () => {
  const result = translateClaudeShapedServer({ command: 'x', args: ['-y', 7] })
  expect(result.ok).toBe(false)
})

test('Cursor ${env:VAR} becomes the ${VAR} form Claudin expands', () => {
  const result = expectOk(
    translateCursorServer({
      url: 'https://api/${env:REGION}/mcp',
      type: 'http',
      headers: { Authorization: 'Bearer ${env:TOKEN}' },
    }),
  )
  expect(result.config).toEqual({
    type: 'http',
    url: 'https://api/${REGION}/mcp',
    headers: { Authorization: 'Bearer ${TOKEN}' },
  })
})

test('Cursor placeholders are rewritten in command, args and env too', () => {
  const result = expectOk(
    translateCursorServer({
      command: '${env:HOME}/bin/server',
      args: ['--key', '${env:KEY}'],
      env: { TOKEN: '${env:TOKEN}' },
    }),
  )
  expect(result.config).toEqual({
    type: 'stdio',
    command: '${HOME}/bin/server',
    args: ['--key', '${KEY}'],
    env: { TOKEN: '${TOKEN}' },
  })
})

test('Gemini httpUrl wins over url and maps to http', () => {
  const result = expectOk(
    translateGeminiServer({
      httpUrl: 'https://x/mcp',
      url: 'https://x/sse',
      headers: { 'X-Key': 'v' },
    }),
  )
  expect(result.config).toEqual({
    type: 'http',
    url: 'https://x/mcp',
    headers: { 'X-Key': 'v' },
  })
})

test('Gemini url alone means SSE, which is not a guess', () => {
  const result = expectOk(translateGeminiServer({ url: 'https://x/sse' }))
  expect(result.config).toEqual({ type: 'sse', url: 'https://x/sse' })
  expect(result.note).toBeUndefined()
})

test('Gemini stdio with cwd still imports — cwd is simply dropped', () => {
  const result = expectOk(
    translateGeminiServer({ command: 'server', args: [], cwd: '/tmp' }),
  )
  expect(result.config).toEqual({ type: 'stdio', command: 'server', args: [] })
})

test('Codex bearer_token_env_var becomes an Authorization header, not a token', () => {
  const result = expectOk(
    translateCodexServer({
      url: 'https://mcp.sentry.dev/mcp',
      bearer_token_env_var: 'SENTRY_TOKEN',
    }),
  )
  expect(result.config).toEqual({
    type: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' },
  })
})

test('Codex http_headers survive and an explicit Authorization is not overwritten', () => {
  const result = expectOk(
    translateCodexServer({
      url: 'https://x/mcp',
      http_headers: { Authorization: 'Basic abc', 'X-Trace': '1' },
      bearer_token_env_var: 'IGNORED',
    }),
  )
  expect(result.config).toEqual({
    type: 'http',
    url: 'https://x/mcp',
    headers: { Authorization: 'Basic abc', 'X-Trace': '1' },
  })
})

test('Codex stdio tables translate straight across', () => {
  const result = expectOk(
    translateCodexServer({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
    }),
  )
  expect(result.config).toEqual({
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { A: '1' },
  })
})

test('opencode packs the executable and its arguments into one array', () => {
  const result = expectOk(
    translateOpencodeServer({
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-github'],
      environment: { GITHUB_TOKEN: '{env:GH}' },
    }),
  )
  expect(result.config).toEqual({
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: '${GH}' },
  })
})

test('an opencode server the user disabled is not re-enabled by importing it', () => {
  const result = translateOpencodeServer({
    type: 'local',
    command: ['server'],
    enabled: false,
  })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('disabled')
})

test('opencode remote entries map to http and rewrite {env:…}', () => {
  const result = expectOk(
    translateOpencodeServer({
      type: 'remote',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer {env:TOKEN}' },
    }),
  )
  expect(result.config).toEqual({
    type: 'http',
    url: 'https://x/mcp',
    headers: { Authorization: 'Bearer ${TOKEN}' },
  })
})

test('opencode {file:…} substitution has no equivalent and is flagged', () => {
  const result = expectOk(
    translateOpencodeServer({
      type: 'local',
      command: ['server', '--key', '{file:~/.key}'],
    }),
  )
  expect(result.note).toContain('{file:')
})

test('an empty opencode command array is refused', () => {
  const result = translateOpencodeServer({ type: 'local', command: [] })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toContain('empty')
})
