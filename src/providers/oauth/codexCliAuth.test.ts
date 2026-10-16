import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getCodexCliAuthPath,
  readCodexCliLogin,
  refreshCodexAuthFileIfNeeded,
} from 'src/providers/oauth/codexCliAuth.js'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function tokenExpiringIn(ms: number): string {
  return makeJwt({ exp: Math.floor((Date.now() + ms) / 1000) })
}

const tempDirs: string[] = []
const originalFetch = globalThis.fetch

function writeAuthFile(contents: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudin-codex-cli-auth-'))
  tempDirs.push(dir)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, JSON.stringify(contents), 'utf8')
  return authPath
}

function codexCliAuthFile(accessToken: string): Record<string, unknown> {
  // The layout the Codex CLI writes for a ChatGPT login.
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'id-old',
      access_token: accessToken,
      refresh_token: 'refresh-old',
      account_id: 'acct_cli',
    },
    last_refresh: '2026-01-01T00:00:00.000000000Z',
  }
}

function stubRefreshEndpoint(
  respond: () => Response = () =>
    Response.json({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new',
    }),
) {
  const fetchMock = mock(async (_input: unknown, _init?: RequestInit) => respond())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('getCodexCliAuthPath', () => {
  test('follows CODEX_HOME the way the Codex CLI does', () => {
    expect(getCodexCliAuthPath({ CODEX_HOME: '/opt/codex' })).toBe(
      '/opt/codex/auth.json',
    )
    expect(getCodexCliAuthPath({})).toEndWith(join('.codex', 'auth.json'))
  })
})

describe('readCodexCliLogin', () => {
  test('reads a ChatGPT login from the Codex CLI layout', () => {
    const accessToken = tokenExpiringIn(3_600_000)
    const authPath = writeAuthFile(codexCliAuthFile(accessToken))

    expect(readCodexCliLogin(authPath)).toEqual({
      authPath,
      accessToken,
      refreshToken: 'refresh-old',
      idToken: 'id-old',
      accountId: 'acct_cli',
    })
  })

  test('takes the account id from the id_token when the file has none', () => {
    const authPath = writeAuthFile({
      tokens: {
        id_token: makeJwt({
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_from_jwt' },
        }),
        access_token: 'access',
        refresh_token: 'refresh',
      },
    })

    expect(readCodexCliLogin(authPath)?.accountId).toBe('acct_from_jwt')
  })

  test('ignores an API-key-only file, a missing file and malformed JSON', () => {
    const apiKeyOnly = writeAuthFile({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' })
    const malformed = writeAuthFile({})
    writeFileSync(malformed, '{not json', 'utf8')

    expect(readCodexCliLogin(apiKeyOnly)).toBeUndefined()
    expect(readCodexCliLogin(malformed)).toBeUndefined()
    expect(readCodexCliLogin(join(tmpdir(), 'no-such-dir', 'auth.json'))).toBeUndefined()
  })

  test('needs a refresh token, or the login could not outlive its access token', () => {
    const authPath = writeAuthFile({
      tokens: { access_token: 'access', account_id: 'acct_cli' },
    })

    expect(readCodexCliLogin(authPath)).toBeUndefined()
  })
})

describe('refreshCodexAuthFileIfNeeded', () => {
  test('leaves a token that is still valid alone', async () => {
    const authPath = writeAuthFile(codexCliAuthFile(tokenExpiringIn(3_600_000)))
    const before = readFileSync(authPath, 'utf8')
    const fetchMock = stubRefreshEndpoint()

    expect(await refreshCodexAuthFileIfNeeded(authPath)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readFileSync(authPath, 'utf8')).toBe(before)
  })

  test('refreshes an expiring token and writes it back in the Codex CLI layout', async () => {
    const authPath = writeAuthFile(codexCliAuthFile(tokenExpiringIn(-60_000)))
    const fetchMock = stubRefreshEndpoint()

    expect(await refreshCodexAuthFileIfNeeded(authPath)).toBe(true)

    const body = String(fetchMock.mock.calls[0]?.[1]?.body)
    expect(new URLSearchParams(body).get('refresh_token')).toBe('refresh-old')

    const written = JSON.parse(readFileSync(authPath, 'utf8'))
    expect(written).toMatchObject({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'id-new',
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        account_id: 'acct_cli',
      },
    })
    expect(Date.parse(written.last_refresh)).toBeGreaterThan(Date.now() - 60_000)
    expect(statSync(authPath).mode & 0o777).toBe(0o600)
    // The temp file the write went through is gone.
    expect(readdirSync(join(authPath, '..'))).toEqual(['auth.json'])
  })

  test('keeps the old refresh and id tokens when the endpoint does not rotate them', async () => {
    const authPath = writeAuthFile(codexCliAuthFile(tokenExpiringIn(-60_000)))
    stubRefreshEndpoint(() => Response.json({ access_token: 'access-new' }))

    expect(await refreshCodexAuthFileIfNeeded(authPath)).toBe(true)

    const { tokens } = JSON.parse(readFileSync(authPath, 'utf8'))
    expect(tokens.refresh_token).toBe('refresh-old')
    expect(tokens.id_token).toBe('id-old')
  })

  test('force refreshes a token the clock still considers valid', async () => {
    const authPath = writeAuthFile(codexCliAuthFile(tokenExpiringIn(3_600_000)))
    const fetchMock = stubRefreshEndpoint()

    expect(await refreshCodexAuthFileIfNeeded(authPath, { force: true })).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('shares one request between concurrent callers', async () => {
    const authPath = writeAuthFile(codexCliAuthFile(tokenExpiringIn(-60_000)))
    const fetchMock = stubRefreshEndpoint()

    const results = await Promise.all([
      refreshCodexAuthFileIfNeeded(authPath),
      refreshCodexAuthFileIfNeeded(authPath),
    ])

    expect(results).toEqual([true, true])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a failed refresh leaves the file untouched and backs off', async () => {
    const authPath = writeAuthFile(codexCliAuthFile(tokenExpiringIn(-60_000)))
    const before = readFileSync(authPath, 'utf8')
    const fetchMock = stubRefreshEndpoint(() =>
      Response.json(
        { error: { code: 'refresh_token_reused', message: 'already used' } },
        { status: 401 },
      ),
    )

    await expect(refreshCodexAuthFileIfNeeded(authPath)).rejects.toThrow(
      'refresh_token_reused',
    )
    expect(readFileSync(authPath, 'utf8')).toBe(before)

    expect(await refreshCodexAuthFileIfNeeded(authPath, { force: true })).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does nothing for a file without a refresh token', async () => {
    const authPath = writeAuthFile({ OPENAI_API_KEY: 'sk-x' })
    const fetchMock = stubRefreshEndpoint()

    expect(await refreshCodexAuthFileIfNeeded(authPath, { force: true })).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
