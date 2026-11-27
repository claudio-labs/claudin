import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  getMcpConnectTimeoutMs,
  getMcpToolTimeoutMs,
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
