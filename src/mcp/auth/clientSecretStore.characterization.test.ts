/**
 * Where an MCP client secret comes from (the environment or a hidden TTY
 * prompt) and where it is kept: the secure store, keyed per server, with the
 * OS vault asked first and a 0600 file under CLAUDIN_CONFIG_DIR as fallback.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import {
  clearMcpClientConfig,
  getServerKey,
  readClientSecret,
  saveMcpClientSecret,
} from 'src/mcp/auth.js'
import { useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'

const store = useIsolatedStore()

describe('readClientSecret', () => {
  test('MCP_CLIENT_SECRET wins without prompting', async () => {
    process.env.MCP_CLIENT_SECRET = 'from-env'
    expect(await readClientSecret()).toBe('from-env')
  })

  test('without a TTY it refuses and names the variable to set', async () => {
    await expect(readClientSecret()).rejects.toThrow(
      'No TTY available to prompt for client secret. Set MCP_CLIENT_SECRET env var instead.',
    )
  })

  describe('at a TTY', () => {
    let hadTty: PropertyDescriptor | undefined
    beforeEach(() => {
      hadTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true })
    })
    afterEach(() => {
      if (hadTty) Object.defineProperty(process.stdin, 'isTTY', hadTty)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
      process.stdin.pause()
    })

    test('keystrokes are collected until Enter, with backspace editing', async () => {
      const cases: [string[], string][] = [
        [['a', 'b', 'c', '\r'], 'abc'],
        [['a', 'b', '\u007F', 'c', '\n'], 'ac'],
        [['x', '\b', 'y', '\r'], 'y'],
        [['\r'], ''],
      ]
      for (const [keys, secret] of cases) {
        const listeners = process.stdin.listenerCount('data')
        const reading = readClientSecret()
        for (const key of keys) process.stdin.emit('data', Buffer.from(key))
        expect(await reading).toBe(secret)
        expect(process.stdin.listenerCount('data')).toBe(listeners)
      }
    })

    test('Ctrl+C cancels the prompt', async () => {
      const listeners = process.stdin.listenerCount('data')
      const reading = readClientSecret()
      for (const key of ['s', '\u0003', 'z', '\r']) process.stdin.emit('data', Buffer.from(key))
      await expect(reading).rejects.toThrow('Cancelled')
      expect(process.stdin.listenerCount('data')).toBe(listeners)
    })
  })
})

describe('saving and clearing a client secret', () => {
  const http: McpHTTPServerConfig = { type: 'http', url: 'https://mcp.test/mcp' }
  const sse: McpSSEServerConfig = { type: 'sse', url: 'https://mcp.test/mcp' }

  test('each server keeps its own secret, beside whatever else the store holds', () => {
    store.write({ mcpOAuth: { untouched: { serverName: 'x', serverUrl: 'y', accessToken: 'z', expiresAt: 1 } } })
    saveMcpClientSecret('docs', http, 'secret-http')
    saveMcpClientSecret('docs', sse, 'secret-sse')
    saveMcpClientSecret('docs', http, 'secret-http-2')
    expect(store.read()).toEqual({
      mcpOAuth: { untouched: { serverName: 'x', serverUrl: 'y', accessToken: 'z', expiresAt: 1 } },
      mcpOAuthClientConfig: {
        [getServerKey('docs', http)]: { clientSecret: 'secret-http-2' },
        [getServerKey('docs', sse)]: { clientSecret: 'secret-sse' },
      },
    })

    clearMcpClientConfig('docs', http)
    expect(store.read()!.mcpOAuthClientConfig).toEqual({ [getServerKey('docs', sse)]: { clientSecret: 'secret-sse' } })
  })

  test('clearing a secret that is not there writes nothing', () => {
    clearMcpClientConfig('docs', http)
    expect(store.read()).toBeNull()
    store.write({ mcpOAuthClientConfig: {} })
    clearMcpClientConfig('docs', http)
    expect(store.read()).toEqual({ mcpOAuthClientConfig: {} })
  })

  test('the OS vault is asked first, and a refusal leaves the secret in a 0600 file in the config dir', () => {
    saveMcpClientSecret('docs', http, 'secret-http')
    const calls = store.vaultCalls()
    expect(calls.some(c => c.startsWith('store --label '))).toBe(true)
    expect(calls.some(c => c.startsWith('lookup service '))).toBe(true)
    expect(statSync(store.credentialsPath()).mode & 0o777).toBe(0o600)
    expect(store.read()!.mcpOAuthClientConfig[getServerKey('docs', http)]).toEqual({ clientSecret: 'secret-http' })
  })
})
