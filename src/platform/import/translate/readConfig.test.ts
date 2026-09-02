import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  readJsonFile,
  readJsoncFile,
  readTextFile,
  readTomlFile,
  readYamlFile,
} from 'src/platform/import/translate/readConfig.js'

function fixture(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudin-import-read-'))
  const path = join(dir, name)
  writeFileSync(path, contents, 'utf8')
  return path
}

test('a missing file is reported as missing, not as an error', () => {
  const result = readJsonFile(join(tmpdir(), 'claudin-import-absent-file.json'))
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toBe('missing')
})

test('readTomlFile parses the shape Codex writes its MCP servers in', () => {
  const path = fixture(
    'config.toml',
    [
      'model = "gpt-5"',
      '',
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-github"]',
      'env = { GITHUB_TOKEN = "t" }',
      '',
      '[mcp_servers.sentry]',
      'url = "https://mcp.sentry.dev/mcp"',
    ].join('\n'),
  )
  const result = readTomlFile(path)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.value.model).toBe('gpt-5')
  expect(result.value.mcp_servers).toEqual({
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 't' },
    },
    sentry: { url: 'https://mcp.sentry.dev/mcp' },
  })
})

test('malformed TOML is invalid, and the message names the file', () => {
  const path = fixture('config.toml', 'model = ')
  const result = readTomlFile(path)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toBe('invalid')
  expect(result.message).toContain(path)
})

test('readJsoncFile accepts comments and trailing commas', () => {
  const path = fixture(
    'opencode.jsonc',
    ['{', '  // the model to use', '  "model": "anthropic/opus",', '}'].join(
      '\n',
    ),
  )
  const result = readJsoncFile(path)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.value.model).toBe('anthropic/opus')
})

test('readJsoncFile reports a genuinely broken document as invalid', () => {
  const path = fixture('opencode.jsonc', '{ "model": }')
  const result = readJsoncFile(path)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toBe('invalid')
})

test('readYamlFile parses a Qwen-style agent file', () => {
  const path = fixture(
    'reviewer.yaml',
    ['name: reviewer', 'description: reviews diffs', 'tools:', '  - Read'].join(
      '\n',
    ),
  )
  const result = readYamlFile(path)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.value.name).toBe('reviewer')
  expect(result.value.tools).toEqual(['Read'])
})

test('a top-level scalar is invalid even when the format parses it', () => {
  const path = fixture('scalar.json', '"just a string"')
  const result = readJsonFile(path)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reason).toBe('invalid')
  expect(result.message).toContain('top level')
})

test('readTextFile returns the raw body for markdown surfaces', () => {
  const path = fixture('AGENTS.md', '# Rules\n\nBe careful.\n')
  const result = readTextFile(path)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.value).toContain('Be careful.')
})
