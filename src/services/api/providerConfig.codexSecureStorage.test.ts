import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Plain-object copies, not the live `import * as` namespace: `mock.module()`
// rewrites a namespace in place, so restoring to one re-applies the stub.
const realOs = { ...(await import('node:os')) }
const realCodexCredentials = {
  ...(await import('src/services/api/codexCredentials.js')),
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('resolveCodexApiCredentials with secure storage', () => {
  afterEach(() => {
    // Restore the real modules. Resetting these to `{}` (as this used to) does
    // not undo the mock — `mock.module` is never undone — it swaps one stub for
    // an emptier one that every later file in the run then reads. The `node:os`
    // case is the dangerous one: the tests below point `homedir()` at a temp
    // dir they delete on the way out, so the rest of the suite resolved `~` to
    // a path that no longer exists. That is what stopped the 15
    // `<REPL> * baseline` snapshots from abbreviating the cwd to `~`.
    mock.module('src/services/api/codexCredentials.js', () => realCodexCredentials)
    mock.module('node:os', () => realOs)
  })

  test('loads Codex credentials from Claudin secure storage', async () => {
    mock.module('src/services/api/codexCredentials.js', () => ({
      isCodexRefreshFailureCoolingDown: () => false,
      readCodexCredentials: () => ({
        apiKey: 'codex-api-key-token',
        accessToken: 'header.payload.signature',
        accountId: 'acct_secure',
      }),
    }))

    const { resolveCodexApiCredentials } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './providerConfig.js?codex-secure-storage'
    )

    const credentials = resolveCodexApiCredentials({} as NodeJS.ProcessEnv)
    expect(credentials.apiKey).toBe('codex-api-key-token')
    expect(credentials.accountId).toBe('acct_secure')
    expect(credentials.source).toBe('secure-storage')
  })

  test('prefers explicit env credentials over secure storage', async () => {
    mock.module('src/services/api/codexCredentials.js', () => ({
      isCodexRefreshFailureCoolingDown: () => false,
      readCodexCredentials: () => ({
        accessToken: 'stored-token',
        accountId: 'acct_stored',
      }),
    }))

    const { resolveCodexApiCredentials } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './providerConfig.js?codex-env-precedence'
    )

    const credentials = resolveCodexApiCredentials({
      CODEX_API_KEY: 'env-token',
      CHATGPT_ACCOUNT_ID: 'acct_env',
    } as NodeJS.ProcessEnv)

    expect(credentials.apiKey).toBe('env-token')
    expect(credentials.accountId).toBe('acct_env')
    expect(credentials.source).toBe('env')
  })

  test('parses nested chatgpt_account_id from a CODEX_API_KEY JWT', async () => {
    mock.module('src/services/api/codexCredentials.js', () => ({
      isCodexRefreshFailureCoolingDown: () => false,
      readCodexCredentials: () => undefined,
    }))

    const { resolveCodexApiCredentials } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './providerConfig.js?codex-env-nested-account'
    )

    const credentials = resolveCodexApiCredentials({
      CODEX_API_KEY: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_nested_env',
        },
      }),
    } as NodeJS.ProcessEnv)

    expect(credentials.accountId).toBe('acct_nested_env')
    expect(credentials.source).toBe('env')
  })

  test('parses nested chatgpt_account_id from auth.json tokens', async () => {
    mock.module('src/services/api/codexCredentials.js', () => ({
      isCodexRefreshFailureCoolingDown: () => false,
      readCodexCredentials: () => undefined,
    }))

    const tempDir = mkdtempSync(join(tmpdir(), 'claudin-codex-auth-'))
    const authPath = join(tempDir, 'auth.json')

    writeFileSync(
      authPath,
      JSON.stringify({
        openai_api_key: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_nested_auth_json',
          },
        }),
      }),
      'utf8',
    )

    try {
      const { resolveCodexApiCredentials } = await import(
        // @ts-expect-error cache-busting query string for Bun module mocks
        './providerConfig.js?codex-auth-json-nested-account'
      )

      const credentials = resolveCodexApiCredentials({
        CODEX_AUTH_JSON_PATH: authPath,
      } as NodeJS.ProcessEnv)

      expect(credentials.accountId).toBe('acct_nested_auth_json')
      expect(credentials.source).toBe('auth.json')
    } finally {
      rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test('does not read default auth.json when secure storage already has Codex credentials', async () => {
    mock.module('src/services/api/codexCredentials.js', () => ({
      isCodexRefreshFailureCoolingDown: () => false,
      readCodexCredentials: () => ({
        apiKey: 'codex-api-key-token',
        accessToken: 'header.payload.signature',
        accountId: 'acct_secure',
      }),
    }))

    const { resolveCodexApiCredentials } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './providerConfig.js?codex-secure-storage-no-auth-io'
    )

    const credentials = resolveCodexApiCredentials({} as NodeJS.ProcessEnv)
    expect(credentials.apiKey).toBe('codex-api-key-token')
    expect(credentials.accountId).toBe('acct_secure')
    expect(credentials.source).toBe('secure-storage')
  })

  test('falls back to the default auth.json when stored Codex refresh is cooling down', async () => {
    const tempHomeDir = mkdtempSync(join(tmpdir(), 'claudin-codex-home-'))
    const authJson = JSON.stringify({
      openai_api_key: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_auth_json',
        },
      }),
    })
    mkdirSync(join(tempHomeDir, '.codex'), { recursive: true })
    writeFileSync(join(tempHomeDir, '.codex', 'auth.json'), authJson, 'utf8')

    mock.module('node:os', () => ({
      ...realOs,
      homedir: () => tempHomeDir,
    }))

    mock.module('src/services/api/codexCredentials.js', () => ({
      isCodexRefreshFailureCoolingDown: () => true,
      readCodexCredentials: () => ({
        accessToken: 'stored-token',
        refreshToken: 'refresh-stored',
        accountId: 'acct_stored',
        lastRefreshFailureAt: Date.now(),
      }),
    }))

    const { resolveCodexApiCredentials } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './providerConfig.js?codex-refresh-cooldown-fallback'
    )

    try {
      const credentials = resolveCodexApiCredentials({} as NodeJS.ProcessEnv)
      expect(credentials.source).toBe('auth.json')
      expect(credentials.accountId).toBe('acct_auth_json')
      expect(credentials.apiKey).not.toBe('stored-token')
    } finally {
      rmSync(tempHomeDir, { force: true, recursive: true })
    }
  })

  test('preserves the stored account id when auth.json fallback lacks one', async () => {
    const tempHomeDir = mkdtempSync(join(tmpdir(), 'claudin-codex-home-'))
    const authJson = JSON.stringify({
      openai_api_key: 'auth-json-access-token',
    })
    mkdirSync(join(tempHomeDir, '.codex'), { recursive: true })
    writeFileSync(join(tempHomeDir, '.codex', 'auth.json'), authJson, 'utf8')

    mock.module('node:os', () => ({
      ...realOs,
      homedir: () => tempHomeDir,
    }))

    mock.module('src/services/api/codexCredentials.js', () => ({
      isCodexRefreshFailureCoolingDown: () => true,
      readCodexCredentials: () => ({
        accessToken: 'stored-token',
        refreshToken: 'refresh-stored',
        accountId: 'acct_stored',
        lastRefreshFailureAt: Date.now(),
      }),
    }))

    const { resolveCodexApiCredentials } = await import(
      // @ts-expect-error cache-busting query string for Bun module mocks
      './providerConfig.js?codex-refresh-cooldown-account-id-fallback'
    )

    try {
      const credentials = resolveCodexApiCredentials({} as NodeJS.ProcessEnv)
      expect(credentials.source).toBe('auth.json')
      expect(credentials.apiKey).toBe('auth-json-access-token')
      expect(credentials.accountId).toBe('acct_stored')
    } finally {
      rmSync(tempHomeDir, { force: true, recursive: true })
    }
  })
})
