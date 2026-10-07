import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ClaudeAuthProvider } from 'src/mcp/auth/claudeAuthProvider.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import type { McpHTTPServerConfig } from 'src/mcp/types.js'
import {
  _setSecureStorageForTesting,
  type SecureStorage,
  type SecureStorageData,
} from 'src/platform/secureStorage/index.js'

/*
 * Since @modelcontextprotocol/sdk 1.31, auth() stamps the client information
 * and tokens it saves with `issuer` — the authorization server they belong to
 * — and on every read discards a stamp naming a different server, so a
 * refresh token or client secret is never presented to another one. That only
 * works if the provider hands the stamp back. These drive the real auth()
 * against an in-memory credential store and a fake authorization server.
 */

type StoredEntry = NonNullable<SecureStorageData['mcpOAuth']>[string]

const SERVER_NAME = 'srv'
const SERVER_URL = 'https://mcp.example.com/mcp'
const AS_URL = 'https://auth.example.com/'
const METADATA = {
  issuer: AS_URL,
  authorization_endpoint: `${AS_URL}authorize`,
  token_endpoint: `${AS_URL}token`,
  response_types_supported: ['code'],
}

async function fetchFn(input: string | URL): Promise<Response> {
  const url = String(input)
  if (url.includes('/.well-known/oauth-authorization-server')) {
    return Response.json(METADATA)
  }
  if (url === METADATA.token_endpoint) {
    return Response.json({
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    })
  }
  return new Response('not found', { status: 404 })
}

function installStorage(
  config: McpHTTPServerConfig,
  fields: Partial<StoredEntry>,
): { entry(): StoredEntry | undefined } {
  let data: SecureStorageData = {
    mcpOAuth: {
      [getServerKey(SERVER_NAME, config)]: {
        serverName: SERVER_NAME,
        serverUrl: SERVER_URL,
        accessToken: 'stored-access',
        refreshToken: 'stored-refresh',
        expiresAt: Date.now() + 3_600_000,
        discoveryState: { authorizationServerUrl: AS_URL },
        ...fields,
      },
    },
  }
  const storage: SecureStorage = {
    name: 'memory',
    read: () => structuredClone(data),
    readAsync: async () => structuredClone(data),
    update: next => {
      data = structuredClone(next)
      return { success: true }
    },
    delete: () => true,
  }
  _setSecureStorageForTesting(storage)
  return { entry: () => data.mcpOAuth?.[getServerKey(SERVER_NAME, config)] }
}

afterEach(() => {
  _setSecureStorageForTesting(null)
  mock.restore()
})

test('credentials refreshed through the SDK come back stamped, so it never warns', async () => {
  const config: McpHTTPServerConfig = { type: 'http', url: SERVER_URL }
  installStorage(config, { clientId: 'registered-client' })
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const provider = new ClaudeAuthProvider(SERVER_NAME, config)

  // The seeded entry predates the stamp, so the first pass warns and binds it.
  expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn })).toBe(
    'AUTHORIZED',
  )
  warn.mockClear()

  expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn })).toBe(
    'AUTHORIZED',
  )
  expect(warn).not.toHaveBeenCalled()
  expect((await provider.tokens())?.issuer).toBe(AS_URL)
  expect((await provider.clientInformation())?.issuer).toBe(AS_URL)
})

test('binding the configured client does not copy it over the config', async () => {
  const config: McpHTTPServerConfig = {
    type: 'http',
    url: SERVER_URL,
    oauth: { clientId: 'configured-client' },
  }
  const storage = installStorage(config, {})
  spyOn(console, 'warn').mockImplementation(() => {})

  await auth(new ClaudeAuthProvider(SERVER_NAME, config), {
    serverUrl: SERVER_URL,
    fetchFn,
  })

  // The stored entry is read before the config, so a copy would shadow every
  // later change to oauth.clientId — the key does not include it.
  expect(storage.entry()?.clientId).toBeUndefined()
  expect(storage.entry()?.clientIssuer).toBe(AS_URL)
  const rotated: McpHTTPServerConfig = {
    ...config,
    oauth: { clientId: 'rotated-client' },
  }
  const info = await new ClaudeAuthProvider(
    SERVER_NAME,
    rotated,
  ).clientInformation()
  expect(info?.client_id).toBe('rotated-client')
  expect(info?.issuer).toBe(AS_URL)
})

// Our own proactive refresh calls the SDK's refreshAuthorization directly and
// saves its unstamped result; a refresh does not change who issued the tokens.
test('tokens saved without a stamp keep the one already stored', async () => {
  const config: McpHTTPServerConfig = { type: 'http', url: SERVER_URL }
  installStorage(config, { tokenIssuer: AS_URL })
  const provider = new ClaudeAuthProvider(SERVER_NAME, config)

  await provider.saveTokens({
    access_token: 'refreshed-access',
    refresh_token: 'refreshed-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
  })

  expect((await provider.tokens())?.issuer).toBe(AS_URL)
})

// tokens() refreshes an expiring token itself, under a lockfile in the config
// dir; when another process got there first it hands back what that process
// stored. Either way the result reaches auth(), so it must carry the stamp.
test('a proactively refreshed token keeps its stamp', async () => {
  const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
  const configDir = mkdtempSync(join(tmpdir(), 'mcp-auth-provider-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  try {
    const config: McpHTTPServerConfig = { type: 'http', url: SERVER_URL }
    const entry = (expiresAt: number): SecureStorageData => ({
      mcpOAuth: {
        [getServerKey(SERVER_NAME, config)]: {
          serverName: SERVER_NAME,
          serverUrl: SERVER_URL,
          accessToken: 'stored-access',
          refreshToken: 'stored-refresh',
          expiresAt,
          tokenIssuer: AS_URL,
        },
      },
    })
    // tokens() reads asynchronously and sees the token about to expire; the
    // re-read under the lock sees the one another process just refreshed.
    _setSecureStorageForTesting({
      name: 'memory',
      read: () => entry(Date.now() + 3_600_000),
      readAsync: async () => entry(Date.now() + 60_000),
      update: () => ({ success: true }),
      delete: () => true,
    })

    const tokens = await new ClaudeAuthProvider(SERVER_NAME, config).tokens()

    expect(tokens?.refresh_token).toBe('stored-refresh')
    expect(tokens?.issuer).toBe(AS_URL)
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('invalidating credentials drops their stamp with them', async () => {
  const config: McpHTTPServerConfig = {
    type: 'http',
    url: SERVER_URL,
    oauth: { clientId: 'configured-client' },
  }
  const storage = installStorage(config, {
    clientId: 'registered-client',
    clientIssuer: AS_URL,
    tokenIssuer: AS_URL,
  })
  const provider = new ClaudeAuthProvider(SERVER_NAME, config)

  await provider.invalidateCredentials('tokens')
  expect(storage.entry()?.tokenIssuer).toBeUndefined()

  // Otherwise the configured client would inherit the registered one's stamp.
  await provider.invalidateCredentials('client')
  expect(storage.entry()?.clientIssuer).toBeUndefined()
  expect((await provider.clientInformation())?.issuer).toBeUndefined()
})
