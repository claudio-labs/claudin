/**
 * Characterization of the pieces every Codex OAuth caller shares: the issuer
 * constants, the env knobs, the account-id claim lookup that becomes the
 * `ChatGPT-Account-Id` header, HTML escaping for the callback pages, and the
 * id-token -> API-key exchange (against a real local issuer).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  asTrimmedString,
  CODEX_API_KEY_TOKEN_NAME,
  CODEX_ID_TOKEN_SUBJECT_TYPE,
  CODEX_OAUTH_ISSUER,
  CODEX_OAUTH_ORIGINATOR,
  CODEX_OAUTH_SCOPE,
  CODEX_REFRESH_URL,
  CODEX_TOKEN_EXCHANGE_GRANT,
  decodeJwtPayload,
  DEFAULT_CODEX_OAUTH_CALLBACK_PORT,
  DEFAULT_CODEX_OAUTH_CLIENT_ID,
  escapeHtml,
  exchangeCodexIdTokenForApiKey,
  getCodexOAuthCallbackPort,
  getCodexOAuthClientId,
  parseChatgptAccountId,
} from 'src/providers/oauth/codexOAuthShared.js'
import {
  type FakeIssuer,
  type IssuerAnswer,
  startFakeIssuer,
  unsignedJwt,
  useCodexSandbox,
} from 'src/providers/oauth/__testutils__/codexAuthHarness.js'

useCodexSandbox()
let issuer: FakeIssuer | undefined
afterEach(() => {
  issuer?.stop()
  issuer = undefined
})

test('issuer constants are the ones the OpenAI backend expects', () => {
  expect({
    CODEX_OAUTH_ISSUER,
    CODEX_REFRESH_URL,
    DEFAULT_CODEX_OAUTH_CLIENT_ID,
    DEFAULT_CODEX_OAUTH_CALLBACK_PORT,
    CODEX_OAUTH_SCOPE,
    CODEX_OAUTH_ORIGINATOR,
    CODEX_API_KEY_TOKEN_NAME,
    CODEX_ID_TOKEN_SUBJECT_TYPE,
    CODEX_TOKEN_EXCHANGE_GRANT,
  }).toEqual({
    CODEX_OAUTH_ISSUER: 'https://auth.openai.com',
    CODEX_REFRESH_URL: 'https://auth.openai.com/oauth/token',
    DEFAULT_CODEX_OAUTH_CLIENT_ID: 'app_EMoamEEZ73f0CkXaXp7hrann',
    DEFAULT_CODEX_OAUTH_CALLBACK_PORT: 1455,
    CODEX_OAUTH_SCOPE:
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
    CODEX_OAUTH_ORIGINATOR: 'codex_cli_rs',
    CODEX_API_KEY_TOKEN_NAME: 'openai-api-key',
    CODEX_ID_TOKEN_SUBJECT_TYPE: 'urn:ietf:params:oauth:token-type:id_token',
    CODEX_TOKEN_EXCHANGE_GRANT: 'urn:ietf:params:oauth:grant-type:token-exchange',
  })
})

describe('asTrimmedString', () => {
  const cases: Array<[unknown, string | undefined]> = [
    ['  padded  ', 'padded'],
    ['plain', 'plain'],
    ['', undefined],
    [' \t\n', undefined],
    [42, undefined],
    [null, undefined],
    [undefined, undefined],
    [{ toString: () => 'obj' }, undefined],
  ]
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input) ?? String(input)} -> ${String(expected)}`, () => {
      expect(asTrimmedString(input)).toBe(expected)
    })
  }
})

describe('env knobs', () => {
  test('client id: trimmed override, otherwise the default; process.env when no env is passed', () => {
    expect(getCodexOAuthClientId({ CODEX_OAUTH_CLIENT_ID: '  custom  ' })).toBe('custom')
    expect(getCodexOAuthClientId({ CODEX_OAUTH_CLIENT_ID: '   ' })).toBe(DEFAULT_CODEX_OAUTH_CLIENT_ID)
    expect(getCodexOAuthClientId({})).toBe(DEFAULT_CODEX_OAUTH_CLIENT_ID)
    process.env.CODEX_OAUTH_CLIENT_ID = 'from-process'
    expect(getCodexOAuthClientId()).toBe('from-process')
  })

  const ports: Array<[raw: string | undefined, port: number]> = [
    [undefined, 1455],
    ['', 1455],
    ['  ', 1455],
    ['0', 0],
    ['8080', 8080],
    [' 9000 ', 9000],
    ['65535', 65535],
    ['65536', 1455],
    ['-1', 1455],
    ['not-a-port', 1455],
    ['3000abc', 3000],
  ]
  for (const [raw, port] of ports) {
    test(`callback port ${JSON.stringify(raw)} -> ${port}`, () => {
      expect(getCodexOAuthCallbackPort({ CODEX_OAUTH_CALLBACK_PORT: raw })).toBe(port)
    })
  }

  test('callback port reads process.env when no env is passed', () => {
    process.env.CODEX_OAUTH_CALLBACK_PORT = '4321'
    expect(getCodexOAuthCallbackPort()).toBe(4321)
  })
})

describe('decodeJwtPayload', () => {
  const urlSafe = unsignedJwt({ note: '>>>???~~~' })
  const cases: Array<[label: string, token: string, expected: unknown]> = [
    ['claims of a well-formed token', unsignedJwt({ sub: 'u', n: 1 }), { sub: 'u', n: 1 }],
    ['base64url characters and missing padding', urlSafe, { note: '>>>???~~~' }],
    ['a token with no dot', 'opaque', undefined],
    ['a payload that is not JSON', 'h.bm90IGpzb24.s', undefined],
    ['a JSON payload that is not an object', `h.${Buffer.from('7').toString('base64url')}.s`, undefined],
    ['a JSON null payload', `h.${Buffer.from('null').toString('base64url')}.s`, undefined],
    ['two segments are enough', `h.${Buffer.from('{"a":true}').toString('base64url')}`, { a: true }],
  ]
  for (const [label, token, expected] of cases) {
    test(label, () => {
      expect(decodeJwtPayload(token)).toEqual(expected as Record<string, unknown> | undefined)
    })
  }

  test('the url-safe fixture really exercises - and _', () => {
    expect(urlSafe.split('.')[1]).toMatch(/[-_]/)
  })
})

describe('parseChatgptAccountId (feeds ChatGPT-Account-Id)', () => {
  const nested = (auth: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    unsignedJwt({ 'https://api.openai.com/auth': auth, ...extra })

  const cases: Array<[label: string, token: string | undefined, expected: string | undefined]> = [
    ['no token', undefined, undefined],
    ['empty token', '', undefined],
    ['opaque token', 'sk-opaque', undefined],
    ['namespaced auth claim wins', nested({ chatgpt_account_id: 'nested' }, { chatgpt_account_id: 'top' }), 'nested'],
    [
      'dotted flat claim is next',
      unsignedJwt({ 'https://api.openai.com/auth.chatgpt_account_id': 'dotted', chatgpt_account_id: 'top' }),
      'dotted',
    ],
    ['top-level claim', unsignedJwt({ chatgpt_account_id: '  top  ' }), 'top'],
    [
      'first organization id is the last resort',
      nested({ organizations: [{ id: 'org-1' }, { id: 'org-2' }] }),
      'org-1',
    ],
    ['empty organizations list', nested({ organizations: [] }), undefined],
    ['organization entries that are not objects', nested({ organizations: ['org-x'] }), undefined],
    ['auth claim that is not an object', unsignedJwt({ 'https://api.openai.com/auth': 'acct' }), undefined],
    [
      'a blank higher-priority claim hides a lower one',
      nested({ chatgpt_account_id: '   ' }, { chatgpt_account_id: 'top' }),
      undefined,
    ],
    ['a non-string claim yields nothing', unsignedJwt({ chatgpt_account_id: 12345 }), undefined],
  ]
  for (const [label, token, expected] of cases) {
    test(label, () => {
      expect(parseChatgptAccountId(token)).toBe(expected)
    })
  }
})

test('escapeHtml neutralises the five markup characters and nothing else', () => {
  const table: Array<[string, string]> = [
    [`<a href="x">Tom & 'Jerry'</a>`, '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;'],
    ['plain text / 100%', 'plain text / 100%'],
    ['&amp;', '&amp;amp;'],
    ['', ''],
  ]
  for (const [raw, escaped] of table) expect(escapeHtml(raw)).toBe(escaped)
})

describe('exchangeCodexIdTokenForApiKey', () => {
  test('posts a token-exchange form for the id token and returns the minted key', async () => {
    issuer = startFakeIssuer(() => ({ body: { access_token: '  sk-minted  ' } }))
    process.env.CODEX_OAUTH_CLIENT_ID = 'exchange-client'

    expect(await exchangeCodexIdTokenForApiKey('id-token-value')).toBe('sk-minted')
    expect(issuer.calls).toEqual([
      {
        method: 'POST',
        path: '/oauth/token',
        contentType: 'application/x-www-form-urlencoded',
        form: {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: 'exchange-client',
          requested_token: 'openai-api-key',
          subject_token: 'id-token-value',
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        },
      },
    ])
  })

  const failures: Array<[answer: IssuerAnswer, message: string]> = [
    [{ status: 401, body: '  token expired  ' }, 'Codex API key exchange failed (401): token expired'],
    [{ status: 503, body: '' }, 'Codex API key exchange failed with status 503.'],
    [{ status: 500, body: ' \n ' }, 'Codex API key exchange failed with status 500.'],
    [{ body: { token_type: 'bearer' } }, 'Codex API key exchange completed, but no API key token was returned.'],
    [{ body: { access_token: '   ' } }, 'Codex API key exchange completed, but no API key token was returned.'],
  ]
  for (const [answer, message] of failures) {
    test(`rejects: ${message}`, async () => {
      issuer = startFakeIssuer(() => answer)
      let caught: unknown
      await exchangeCodexIdTokenForApiKey('id').catch(error => {
        caught = error
      })
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toBe(message)
    })
  }
})
