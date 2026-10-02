/**
 * Characterization of the stored Codex (ChatGPT) OAuth credentials: where they
 * live, what shape they take on disk, when a refresh fires, how concurrent
 * refreshes collapse into one, and how a failed refresh is reported and
 * remembered. A port of opencode's Codex plugin has to keep all of it.
 *
 * Storage is the real plaintext store under a temp CLAUDIN_CONFIG_DIR, and the
 * issuer is a real local HTTP server (see __testutils__/codexAuthHarness.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { saveGlobalConfig } from 'src/platform/config/config.js'
import {
  attachCodexProfileIdToStoredCredentials,
  clearCodexCredentials,
  CODEX_STORAGE_KEY,
  type CodexCredentialBlob,
  isCodexRefreshFailureCoolingDown,
  readCodexCredentials,
  readCodexCredentialsAsync,
  refreshCodexAccessTokenIfNeeded,
  saveCodexCredentials,
} from 'src/providers/oauth/codexCredentials.js'
import { resolveStoredCodexCredentials } from 'src/providers/presets/providerConfig.js'
import {
  EXCHANGE_GRANT,
  expIn,
  type FakeIssuer,
  type IssuerAnswer,
  type IssuerCall,
  REFRESH_GRANT,
  startFakeIssuer,
  unsignedJwt,
  useCodexSandbox,
} from 'src/providers/oauth/__testutils__/codexAuthHarness.js'

const sandbox = useCodexSandbox()
let issuer: FakeIssuer | undefined

beforeEach(() => {
  // Also drops any cooldown a previous test left in module memory.
  clearCodexCredentials()
  rmSync(sandbox.credentialsPath, { force: true })
})

afterEach(() => {
  issuer?.stop()
  issuer = undefined
})

function storeOnDisk(contents: Record<string, unknown>): void {
  mkdirSync(sandbox.configDir, { recursive: true })
  writeFileSync(sandbox.credentialsPath, JSON.stringify(contents))
}

function onDisk(): Record<string, any> {
  return JSON.parse(readFileSync(sandbox.credentialsPath, 'utf8'))
}

type Settled =
  | { ok: true; refreshed: boolean; credentials?: CodexCredentialBlob }
  | { ok: false; failure: string }

/** Runs one refresh and folds a rejection into a value, so cases can be tabled. */
async function settle(options?: { force?: boolean }): Promise<Settled> {
  try {
    return { ok: true, ...(await refreshCodexAccessTokenIfNeeded(options)) }
  } catch (error) {
    return { ok: false, failure: (error as Error).message }
  }
}

const staleAccess = () => unsignedJwt({ exp: expIn(-5_000), chatgpt_account_id: 'acct-before' })
const freshAccess = (account = 'acct-after') =>
  unsignedJwt({ exp: expIn(3_600_000), chatgpt_account_id: account })
const freshId = (account = 'acct-from-id') =>
  unsignedJwt({
    exp: expIn(3_600_000),
    'https://api.openai.com/auth': { chatgpt_account_id: account },
  })

/** An issuer that rotates tokens on refresh and mints `minted-key` on exchange. */
function healthyIssuer(overrides: {
  refresh?: (call: IssuerCall) => IssuerAnswer | Promise<IssuerAnswer>
  exchange?: (call: IssuerCall) => IssuerAnswer | Promise<IssuerAnswer>
} = {}): FakeIssuer {
  const refreshed = freshAccess()
  const idToken = freshId()
  issuer = startFakeIssuer(call => {
    if (call.form.grant_type === REFRESH_GRANT) {
      return overrides.refresh?.(call) ?? {
        body: { access_token: refreshed, refresh_token: 'rt-rotated', id_token: idToken },
      }
    }
    return overrides.exchange?.(call) ?? { body: { access_token: 'minted-key' } }
  })
  return issuer
}

describe('credential file', () => {
  test('lives in CLAUDIN_CONFIG_DIR/.credentials.json under the "codex" key, owner-only', () => {
    const blob = { accessToken: 'at-1', refreshToken: 'rt-1', idToken: 'not-a-jwt', accountId: 'acct-1', apiKey: 'key-1' }
    const before = Date.now()
    expect(saveCodexCredentials(blob)).toMatchObject({ success: true })
    expect(CODEX_STORAGE_KEY).toBe('codex')

    const stored = onDisk()[CODEX_STORAGE_KEY]
    expect(stored).toMatchObject(blob)
    expect(stored.lastRefreshAt).toBeGreaterThanOrEqual(before)
    expect(statSync(sandbox.credentialsPath).mode & 0o777).toBe(0o600)
  })

  test('saving keeps other providers\' entries and an earlier linked profile id', () => {
    storeOnDisk({
      xai: { accessToken: 'xai-token' },
      codex: { accessToken: 'old', profileId: 'profile-linked' },
    })
    saveCodexCredentials({ accessToken: 'new', lastRefreshAt: 42 })

    const file = onDisk()
    expect(file.xai).toEqual({ accessToken: 'xai-token' })
    expect(file.codex.accessToken).toBe('new')
    expect(file.codex.profileId).toBe('profile-linked')
    expect(file.codex.lastRefreshAt).toBe(42)
  })

  test('a blob without an access token is refused and nothing is written', () => {
    expect(saveCodexCredentials({ accessToken: '   ', refreshToken: 'rt' })).toEqual({
      success: false,
      warning: 'Codex credentials are incomplete.',
    })
    expect(existsSync(sandbox.credentialsPath)).toBe(false)
  })

  const readCases: Array<{ name: string; codex: unknown; expected: unknown }> = [
    { name: 'nothing stored', codex: undefined, expected: undefined },
    { name: 'not an object', codex: 'token', expected: undefined },
    { name: 'blank access token', codex: { accessToken: '  ' }, expected: undefined },
    {
      name: 'strings are trimmed and blanks dropped',
      codex: { accessToken: ' at ', refreshToken: ' rt ', apiKey: '', accountId: ' acct ' },
      expected: { accessToken: 'at', refreshToken: 'rt', accountId: 'acct' },
    },
    {
      name: 'timestamps that are not numbers are dropped',
      codex: { accessToken: 'at', lastRefreshAt: '5', lastRefreshFailureAt: null },
      expected: { accessToken: 'at' },
    },
    {
      name: 'numeric timestamps survive',
      codex: { accessToken: 'at', lastRefreshAt: 7, lastRefreshFailureAt: 9, profileId: 'p' },
      expected: { accessToken: 'at', lastRefreshAt: 7, lastRefreshFailureAt: 9, profileId: 'p' },
    },
    {
      name: 'account id falls back to the id token claim',
      codex: { accessToken: unsignedJwt({ chatgpt_account_id: 'from-access' }), idToken: freshId('from-id') },
      expected: { accountId: 'from-id' },
    },
    {
      name: 'then to the access token claim',
      codex: { accessToken: unsignedJwt({ chatgpt_account_id: 'from-access' }) },
      expected: { accountId: 'from-access' },
    },
  ]

  for (const { name, codex, expected } of readCases) {
    test(`read: ${name}`, async () => {
      storeOnDisk(codex === undefined ? {} : { codex })
      const sync = readCodexCredentials()
      const viaAsync = await readCodexCredentialsAsync()
      if (expected === undefined) {
        expect(sync).toBeUndefined()
      } else {
        expect(sync).toMatchObject(expected as object)
        if ('apiKey' in (codex as object)) expect(sync?.apiKey).toBeUndefined()
      }
      expect(viaAsync).toEqual(sync)
    })
  }

  test('read: an unparseable file reads as no credentials', () => {
    mkdirSync(sandbox.configDir, { recursive: true })
    writeFileSync(sandbox.credentialsPath, '{ not json')
    expect(readCodexCredentials()).toBeUndefined()
  })

  test('clearing removes only the codex entry', () => {
    storeOnDisk({ codex: { accessToken: 'at' }, kimiDeviceId: 'dev-1' })
    expect(clearCodexCredentials().success).toBe(true)
    expect(onDisk()).toEqual({ kimiDeviceId: 'dev-1' })
    expect(readCodexCredentials()).toBeUndefined()
  })

  test('attaching a profile id needs stored credentials first', () => {
    expect(attachCodexProfileIdToStoredCredentials('profile-x')).toEqual({
      success: false,
      warning: 'Codex credentials are not stored securely yet.',
    })

    storeOnDisk({ codex: { accessToken: 'at', refreshToken: 'rt' } })
    expect(attachCodexProfileIdToStoredCredentials('profile-x').success).toBe(true)
    expect(onDisk().codex).toMatchObject({ accessToken: 'at', refreshToken: 'rt', profileId: 'profile-x' })
  })
})

describe('bare mode turns the store off', () => {
  test('every entry point reports it and nothing touches disk or network', async () => {
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt' } })
    const issuerSeen = healthyIssuer()
    process.env.CLAUDIN_SIMPLE = '1'

    const bareWarning = { success: false, warning: 'Bare mode: secure storage is disabled.' }
    expect(readCodexCredentials()).toBeUndefined()
    expect(await readCodexCredentialsAsync()).toBeUndefined()
    expect(saveCodexCredentials({ accessToken: 'at' })).toEqual(bareWarning)
    expect(attachCodexProfileIdToStoredCredentials('p')).toEqual(bareWarning)
    expect(clearCodexCredentials()).toEqual({ success: true })
    expect(await refreshCodexAccessTokenIfNeeded({ force: true })).toEqual({ refreshed: false })

    expect(onDisk().codex.refreshToken).toBe('rt')
    expect(issuerSeen.calls).toHaveLength(0)
  })
})

describe('refresh cooldown predicate', () => {
  const now = 1_000_000
  const cases: Array<[label: string, failedAt: number | undefined, cooling: boolean]> = [
    ['never failed', undefined, false],
    ['failed just now', now, true],
    ['failed 59s ago', now - 59_000, true],
    ['failed exactly 60s ago', now - 60_000, false],
    ['failed 2 minutes ago', now - 120_000, false],
  ]
  for (const [label, failedAt, cooling] of cases) {
    test(label, () => {
      expect(isCodexRefreshFailureCoolingDown({ lastRefreshFailureAt: failedAt }, now)).toBe(cooling)
    })
  }

  test('defaults "now" to the wall clock', () => {
    expect(isCodexRefreshFailureCoolingDown({ lastRefreshFailureAt: Date.now() - 1_000 })).toBe(true)
  })
})

describe('when a refresh fires', () => {
  type TimingCase = {
    label: string
    stored: () => Record<string, unknown>
    force?: boolean
    expectRequest: boolean
  }
  const timing: TimingCase[] = [
    {
      label: 'access token already expired',
      stored: () => ({ accessToken: staleAccess(), refreshToken: 'rt' }),
      expectRequest: true,
    },
    {
      label: 'access token expires inside the 60s skew',
      stored: () => ({ accessToken: unsignedJwt({ exp: expIn(30_000) }), refreshToken: 'rt' }),
      expectRequest: true,
    },
    {
      label: 'access token good for two more minutes',
      stored: () => ({ accessToken: unsignedJwt({ exp: expIn(120_000) }), refreshToken: 'rt' }),
      expectRequest: false,
    },
    {
      label: 'opaque access token, expired id token',
      stored: () => ({ accessToken: 'opaque', idToken: unsignedJwt({ exp: expIn(-1_000) }), refreshToken: 'rt' }),
      expectRequest: true,
    },
    {
      label: 'no expiry anywhere',
      stored: () => ({ accessToken: 'opaque', idToken: unsignedJwt({ sub: 'x' }), refreshToken: 'rt' }),
      expectRequest: false,
    },
    {
      label: 'exp claim that is not a number',
      stored: () => ({ accessToken: unsignedJwt({ exp: 'soon' }), refreshToken: 'rt' }),
      expectRequest: false,
    },
    {
      label: 'forced while still fresh',
      stored: () => ({ accessToken: freshAccess(), refreshToken: 'rt' }),
      force: true,
      expectRequest: true,
    },
    {
      label: 'expired but no refresh token',
      stored: () => ({ accessToken: staleAccess() }),
      force: true,
      expectRequest: false,
    },
  ]

  for (const { label, stored, force, expectRequest } of timing) {
    test(label, async () => {
      const blob = stored()
      storeOnDisk({ codex: blob })
      const seen = healthyIssuer()

      const outcome = await settle(force ? { force } : undefined)

      expect(seen.callsOfGrant(REFRESH_GRANT)).toHaveLength(expectRequest ? 1 : 0)
      expect(outcome).toMatchObject({
        ok: true,
        refreshed: expectRequest,
        credentials: { accessToken: expectRequest ? expect.any(String) : blob.accessToken },
      })
    })
  }

  test('nothing stored: no request and no credentials', async () => {
    const seen = healthyIssuer()
    expect(await refreshCodexAccessTokenIfNeeded({ force: true })).toEqual({ refreshed: false })
    expect(seen.calls).toHaveLength(0)
  })

  test('an active profile that pins an API key skips the refresh entirely', async () => {
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt' } })
    const seen = healthyIssuer()
    saveGlobalConfig(prev => ({
      ...prev,
      providerProfiles: [
        {
          id: 'pinned',
          name: 'Pinned key',
          provider: 'openai',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          model: 'codexplan',
          apiKey: 'sk-pinned',
        },
      ],
      activeProviderProfileId: 'pinned',
    }))

    expect(await refreshCodexAccessTokenIfNeeded({ force: true })).toEqual({ refreshed: false })
    expect(seen.calls).toHaveLength(0)
  })
})

describe('a successful refresh', () => {
  test('posts a form-encoded refresh grant to /oauth/token', async () => {
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt-original' } })
    process.env.CODEX_OAUTH_CLIENT_ID = '  client-under-test  '
    const seen = healthyIssuer()

    await refreshCodexAccessTokenIfNeeded()

    const [refresh] = seen.callsOfGrant(REFRESH_GRANT)
    expect(refresh).toEqual({
      method: 'POST',
      path: '/oauth/token',
      contentType: 'application/x-www-form-urlencoded',
      form: {
        client_id: 'client-under-test',
        grant_type: 'refresh_token',
        refresh_token: 'rt-original',
      },
    })
  })

  test('stores rotated tokens, the minted API key and the new account id', async () => {
    storeOnDisk({
      codex: {
        accessToken: staleAccess(),
        refreshToken: 'rt-original',
        accountId: 'acct-before',
        profileId: 'profile-linked',
        lastRefreshFailureAt: Date.now() - 600_000,
      },
    })
    const seen = healthyIssuer()

    const { credentials: next, refreshed } = await refreshCodexAccessTokenIfNeeded()

    const [exchange] = seen.callsOfGrant(EXCHANGE_GRANT)
    expect(exchange.form).toEqual({
      grant_type: EXCHANGE_GRANT,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      requested_token: 'openai-api-key',
      subject_token: next!.idToken!,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    })

    expect(refreshed).toBe(true)
    expect(next).toMatchObject({
      refreshToken: 'rt-rotated',
      apiKey: 'minted-key',
      accountId: 'acct-from-id',
    })

    const stored = onDisk().codex
    expect(stored).toMatchObject({
      accessToken: next!.accessToken,
      refreshToken: 'rt-rotated',
      apiKey: 'minted-key',
      accountId: 'acct-from-id',
      profileId: 'profile-linked',
    })
    expect(stored.lastRefreshFailureAt).toBeUndefined()
  })

  type CarryCase = {
    label: string
    reply: Record<string, unknown>
    stored: Record<string, unknown>
    expected: Record<string, unknown>
    exchanges: number
  }
  const carry: CarryCase[] = [
    {
      label: 'no new refresh or id token: the old ones are kept and the old id token is exchanged',
      reply: { access_token: 'opaque-new' },
      stored: { refreshToken: 'rt-keep', idToken: 'id-keep', accountId: 'acct-keep' },
      expected: { accessToken: 'opaque-new', refreshToken: 'rt-keep', idToken: 'id-keep', accountId: 'acct-keep', apiKey: 'minted-key' },
      exchanges: 1,
    },
    {
      label: 'account id read from the new access token when there is no id token',
      reply: { access_token: freshAccess('acct-in-access') },
      stored: { refreshToken: 'rt-keep', accountId: 'acct-keep' },
      expected: { refreshToken: 'rt-keep', accountId: 'acct-in-access' },
      exchanges: 0,
    },
  ]
  for (const { label, reply, stored, expected, exchanges } of carry) {
    test(label, async () => {
      storeOnDisk({ codex: { accessToken: staleAccess(), ...stored } })
      const seen = healthyIssuer({ refresh: () => ({ body: reply }) })

      const { credentials: next } = await refreshCodexAccessTokenIfNeeded()

      expect(next).toMatchObject(expected)
      expect(seen.callsOfGrant(EXCHANGE_GRANT)).toHaveLength(exchanges)
      if (exchanges === 0) expect(next?.apiKey).toBeUndefined()
    })
  }

  test('a failed API-key exchange still refreshes, and the transport falls back to the access token', async () => {
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt', apiKey: 'stale-key' } })
    healthyIssuer({ exchange: () => ({ status: 502, body: 'upstream down' }) })

    expect(await settle()).toMatchObject({ ok: true, refreshed: true })

    const stored = readCodexCredentials()!
    expect(stored.apiKey).toBeUndefined()
    // What the Codex transport turns into `Authorization: Bearer …` and
    // `ChatGPT-Account-Id`.
    expect(resolveStoredCodexCredentials({ storedCredentials: stored })).toEqual({
      apiKey: stored.accessToken,
      accountId: 'acct-from-id',
      source: 'secure-storage',
    })
  })

  test('after a full refresh the transport sends the minted API key', async () => {
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt' } })
    healthyIssuer()
    await refreshCodexAccessTokenIfNeeded()

    expect(resolveStoredCodexCredentials({ storedCredentials: readCodexCredentials()! })).toEqual({
      apiKey: 'minted-key',
      accountId: 'acct-from-id',
      source: 'secure-storage',
    })
  })

  const exchangeFailures: Array<[label: string, answer: IssuerAnswer]> = [
    ['an exchange reply without a token', { body: { token_type: 'bearer' } }],
    ['an exchange rejected with an empty body', { status: 500, body: '' }],
  ]
  for (const [label, answer] of exchangeFailures) {
    test(`${label} leaves the API key unset`, async () => {
      storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt' } })
      healthyIssuer({ exchange: () => answer })
      const outcome = await settle()
      expect(outcome).toMatchObject({ ok: true, refreshed: true })
      expect(outcome.ok ? outcome.credentials?.apiKey : 'failed').toBeUndefined()
    })
  }
})

describe('single flight', () => {
  test('concurrent callers share one request and one result, and the next call starts a new one', async () => {
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt' } })
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const seen = healthyIssuer({
      refresh: async () => {
        await held
        return { body: { access_token: freshAccess(), refresh_token: 'rt-next' } }
      },
    })

    const callers = Array.from({ length: 4 }, () => refreshCodexAccessTokenIfNeeded())
    while (seen.callsOfGrant(REFRESH_GRANT).length === 0) await Bun.sleep(2)
    release()
    const results = await Promise.all(callers)

    expect(seen.callsOfGrant(REFRESH_GRANT)).toHaveLength(1)
    for (const result of results) expect(result).toBe(results[0])
    expect(results[0].refreshed).toBe(true)

    await refreshCodexAccessTokenIfNeeded({ force: true })
    expect(seen.callsOfGrant(REFRESH_GRANT)).toHaveLength(2)
    expect(seen.callsOfGrant(REFRESH_GRANT)[1].form.refresh_token).toBe('rt-next')
  })

  test('concurrent callers all see the same failure', async () => {
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt' } })
    const seen = healthyIssuer({ refresh: () => ({ status: 401, body: '' }) })

    const outcomes = await Promise.allSettled([
      refreshCodexAccessTokenIfNeeded(),
      refreshCodexAccessTokenIfNeeded(),
    ])
    expect(seen.callsOfGrant(REFRESH_GRANT)).toHaveLength(1)
    const reasons = outcomes.map(o => (o.status === 'rejected' ? (o.reason as Error).message : 'resolved'))
    expect(reasons).toEqual([
      'Codex token refresh failed with status 401.',
      'Codex token refresh failed with status 401.',
    ])
  })
})

describe('refresh failures', () => {
  const classification: Array<[status: number, body: unknown, message: string]> = [
    [400, '', 'Codex token refresh failed with status 400.'],
    [400, '   ', 'Codex token refresh failed with status 400.'],
    [
      401,
      { error: { code: 'refresh_token_reused', message: 'already used' } },
      'Codex token refresh failed (refresh_token_reused): already used',
    ],
    [
      400,
      { error: 'invalid_grant', error_description: 'token revoked' },
      'Codex token refresh failed with status 400: token revoked',
    ],
    [
      403,
      { code: 'account_deactivated', error_description: 'gone' },
      'Codex token refresh failed (account_deactivated): gone',
    ],
    [
      400,
      { error: { code: 'no_message' } },
      'Codex token refresh failed (no_message): {"error":{"code":"no_message"}}',
    ],
    [502, '  bad gateway  ', 'Codex token refresh failed with status 502: bad gateway'],
    [
      500,
      { detail: 'opaque' },
      'Codex token refresh failed with status 500: {"detail":"opaque"}',
    ],
    [200, { refresh_token: 'only-this' }, 'Codex token refresh succeeded without a new access token.'],
  ]

  for (const [status, body, message] of classification) {
    test(`${status} ${JSON.stringify(body)} -> ${message}`, async () => {
      storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt', profileId: 'keep-me' } })
      const before = Date.now()
      healthyIssuer({ refresh: () => ({ status, body }) })

      expect(await settle()).toEqual({ ok: false, failure: message })

      const stored = onDisk().codex
      expect(stored.refreshToken).toBe('rt')
      expect(stored.profileId).toBe('keep-me')
      expect(stored.lastRefreshFailureAt).toBeGreaterThanOrEqual(before)
    })
  }

  test('a recorded failure blocks both lazy and forced refreshes for the cooldown', async () => {
    const access = staleAccess()
    storeOnDisk({ codex: { accessToken: access, refreshToken: 'rt' } })
    const seen = healthyIssuer({ refresh: () => ({ status: 500, body: 'down' }) })

    const outcomes = [await settle(), await settle(), await settle({ force: true })]
    expect(outcomes).toEqual([
      { ok: false, failure: 'Codex token refresh failed with status 500: down' },
      { ok: true, refreshed: false, credentials: expect.objectContaining({ accessToken: access }) },
      { ok: true, refreshed: false, credentials: expect.objectContaining({ accessToken: access }) },
    ])
    expect(seen.callsOfGrant(REFRESH_GRANT)).toHaveLength(1)
  })

  test('a failure stamped on disk by another process is honoured', async () => {
    storeOnDisk({
      codex: { accessToken: staleAccess(), refreshToken: 'rt', lastRefreshFailureAt: Date.now() - 10_000 },
    })
    const seen = healthyIssuer()
    expect(await settle({ force: true })).toMatchObject({ ok: true, refreshed: false })
    expect(seen.calls).toHaveLength(0)
  })

  test('when the store cannot be written, the refresh fails and the cooldown is kept in memory', async () => {
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt' } })
    let lockStore = true
    const seen = healthyIssuer({
      refresh: () => {
        if (lockStore) chmodSync(sandbox.credentialsPath, 0o400)
        lockStore = false
        return { body: { access_token: freshAccess(), refresh_token: 'rt-lost' } }
      },
    })

    expect(await settle()).toEqual({
      ok: false,
      failure: 'Codex token refresh succeeded but credentials could not be saved.',
    })
    expect(onDisk().codex.refreshToken).toBe('rt')
    expect(onDisk().codex.lastRefreshFailureAt).toBeUndefined()

    const again = await refreshCodexAccessTokenIfNeeded({ force: true })
    expect(again.refreshed).toBe(false)
    expect(seen.callsOfGrant(REFRESH_GRANT)).toHaveLength(1)

    // A successful save (here: a clear) lifts the in-memory cooldown.
    chmodSync(sandbox.credentialsPath, 0o600)
    clearCodexCredentials()
    storeOnDisk({ codex: { accessToken: staleAccess(), refreshToken: 'rt' } })
    expect((await refreshCodexAccessTokenIfNeeded()).refreshed).toBe(true)
  })
})
