import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  getMcpConnectTimeoutMs,
  getMcpToolTimeoutMs,
  resolveStdioCwd,
} from 'src/mcp/client/serverOptions.js'

const ENV_KEYS = ['MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('getMcpConnectTimeoutMs', () => {
  test('defaults to 30 s', () => {
    expect(DEFAULT_MCP_CONNECT_TIMEOUT_MS).toBe(30_000)
    expect(getMcpConnectTimeoutMs()).toBe(30_000)
  })

  test('MCP_TIMEOUT overrides it', () => {
    process.env.MCP_TIMEOUT = '5000'
    expect(getMcpConnectTimeoutMs()).toBe(5000)
  })

  test('a value that is not a positive number falls back to the default', () => {
    for (const raw of ['soon', '0', '-5']) {
      process.env.MCP_TIMEOUT = raw
      expect(getMcpConnectTimeoutMs()).toBe(30_000)
    }
  })
})

describe('getMcpToolTimeoutMs', () => {
  test('defaults to 5 min', () => {
    expect(DEFAULT_MCP_TOOL_TIMEOUT_MS).toBe(300_000)
    expect(getMcpToolTimeoutMs()).toBe(300_000)
  })

  test('MCP_TOOL_TIMEOUT overrides it', () => {
    process.env.MCP_TOOL_TIMEOUT = '900000'
    expect(getMcpToolTimeoutMs()).toBe(900_000)
  })

  test('a value that is not a positive number falls back to the default', () => {
    process.env.MCP_TOOL_TIMEOUT = '-1'
    expect(getMcpToolTimeoutMs()).toBe(300_000)
  })
})

describe('per-server timeouts', () => {
  test('a server’s own timeouts win over the env', () => {
    process.env.MCP_TIMEOUT = '5000'
    process.env.MCP_TOOL_TIMEOUT = '6000'
    const config = { command: 'npx', args: [], startupTimeout: 60_000, toolTimeout: 900_000 }
    expect(getMcpConnectTimeoutMs(config)).toBe(60_000)
    expect(getMcpToolTimeoutMs(config)).toBe(900_000)
  })

  test('a server without them falls back to the env, then the default', () => {
    const http = { type: 'http' as const, url: 'https://srv/mcp' }
    expect(getMcpConnectTimeoutMs(http)).toBe(30_000)
    process.env.MCP_TOOL_TIMEOUT = '6000'
    expect(getMcpToolTimeoutMs(http)).toBe(6000)
  })

  test('a server type that has no timeout fields uses the env and defaults', () => {
    const sdk = { type: 'sdk' as const, name: 'in-proc' }
    expect(getMcpConnectTimeoutMs(sdk)).toBe(30_000)
    expect(getMcpToolTimeoutMs(sdk)).toBe(300_000)
  })
})

describe('cwd and ${VAR} expansion', () => {
  // A source pin: print.test.ts mock.module()s src/mcp/config.js, which Bun
  // applies for the whole run, so its real exports cannot be asserted on.
  test('config.ts expands a stdio cwd with the rest of the stdio config', () => {
    const src = readFileSync(new URL('../config.ts', import.meta.url), 'utf8')
    expect(src).toContain('cwd: stdioConfig.cwd ? expandString(stdioConfig.cwd) : undefined,')
  })
})

describe('resolveStdioCwd', () => {
  test('no cwd means the process cwd, so nothing is passed', () => {
    expect(resolveStdioCwd(undefined, '/proj', '/home/me')).toBeUndefined()
    expect(resolveStdioCwd('', '/proj', '/home/me')).toBeUndefined()
  })

  test('~ is the home dir', () => {
    expect(resolveStdioCwd('~', '/proj', '/home/me')).toBe('/home/me')
    expect(resolveStdioCwd('~/tools/slow', '/proj', '/home/me')).toBe('/home/me/tools/slow')
  })

  test('an absolute path is kept and a relative one is under the project dir', () => {
    expect(resolveStdioCwd('/opt/srv', '/proj', '/home/me')).toBe('/opt/srv')
    expect(resolveStdioCwd('tools/srv', '/proj', '/home/me')).toBe('/proj/tools/srv')
    expect(resolveStdioCwd('../sibling', '/proj', '/home/me')).toBe('/sibling')
    expect(resolveStdioCwd('~other', '/proj', '/home/me')).toBe('/proj/~other')
  })
})
