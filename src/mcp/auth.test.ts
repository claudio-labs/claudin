import assert from 'node:assert/strict'
import test from 'node:test'

import * as authModule from 'src/mcp/auth.js'
import {
  AuthenticationCancelledError,
  ClaudeAuthProvider,
  getFirstOAuthCallbackParam,
  getScopeFromMetadata,
  getServerKey,
  normalizeOAuthErrorBody,
  redactSensitiveUrlParams,
  validateOAuthCallbackParams,
} from 'src/mcp/auth.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'

/*
 * What is covered here and what is not.
 *
 * Everything below the callback-param tests is the PURE half of the OAuth
 * client — the decision logic, exercised for real. The I/O half
 * (`ClaudeAuthProvider`, `performMCPOAuthFlow`, `createAuthFetch`,
 * `revokeToken`) opens a browser, runs a loopback server and reads the OS
 * credential vault; it is held by the surface pin at the bottom of this file
 * and NOT by behaviour. It is deliberately not forced under test with
 * `mock.module`, because module mocks leak across every file in the run.
 *
 * `hasMcpDiscoveryButNoToken` is in that second group despite being three
 * lines long: it calls `getSecureStorage()` with no injection seam, so driving
 * its two interesting branches would mean writing into the developer's real
 * keychain. Surface pin only.
 */

test('OAuth callback rejects error parameters before state validation can be bypassed', () => {
  const result = validateOAuthCallbackParams(
    {
      error: 'access_denied',
      error_description: 'denied by provider',
    },
    'expected-state',
  )

  assert.deepEqual(result, { type: 'state_mismatch' })
})

test('OAuth callback accepts provider errors only when state matches', () => {
  const result = validateOAuthCallbackParams(
    {
      state: 'expected-state',
      error: 'access_denied',
      error_description: 'denied by provider',
      error_uri: 'https://example.test/error',
    },
    'expected-state',
  )

  assert.deepEqual(result, {
    type: 'error',
    error: 'access_denied',
    errorDescription: 'denied by provider',
    errorUri: 'https://example.test/error',
    message:
      'OAuth error: access_denied - denied by provider (See: https://example.test/error)',
  })
})

test('OAuth callback accepts authorization codes only when state matches', () => {
  assert.deepEqual(
    validateOAuthCallbackParams(
      {
        state: 'expected-state',
        code: 'auth-code',
      },
      'expected-state',
    ),
    { type: 'code', code: 'auth-code' },
  )

  assert.deepEqual(
    validateOAuthCallbackParams(
      {
        state: 'wrong-state',
        code: 'auth-code',
      },
      'expected-state',
    ),
    { type: 'state_mismatch' },
  )
})

test('a polluted state parameter cannot smuggle a match past validation', () => {
  // Duplicated query params arrive as an array; only the FIRST non-empty value
  // is considered, so appending the real state to a forged one must not pass.
  assert.deepEqual(
    validateOAuthCallbackParams(
      { code: 'auth-code', state: ['attacker-state', 'expected-state'] },
      'expected-state',
    ),
    { type: 'state_mismatch' },
  )
})

test('a callback carrying neither a code nor an error is a missing result', () => {
  assert.deepEqual(
    validateOAuthCallbackParams({ state: 'expected-state' }, 'expected-state'),
    { type: 'missing_result' },
  )
})

// ── getFirstOAuthCallbackParam ─────────────────────────────────────────────

test('a repeated query parameter resolves to its first non-empty value', () => {
  assert.equal(getFirstOAuthCallbackParam(['first', 'second']), 'first')
  assert.equal(getFirstOAuthCallbackParam(['', 'second']), 'second')
  assert.equal(getFirstOAuthCallbackParam(['', '']), undefined)
})

test('an absent or empty parameter is undefined, never the empty string', () => {
  assert.equal(getFirstOAuthCallbackParam(undefined), undefined)
  assert.equal(getFirstOAuthCallbackParam(null), undefined)
  assert.equal(getFirstOAuthCallbackParam(''), undefined)
  assert.equal(getFirstOAuthCallbackParam('code'), 'code')
})

// ── normalizeOAuthErrorBody ────────────────────────────────────────────────

/* Spelled out rather than imported from the module: a loop over the module's
 * own alias Set would shrink with the Set and stay green if an alias were
 * dropped. */
const NONSTANDARD_INVALID_GRANT_SPELLINGS = [
  'invalid_refresh_token',
  'expired_refresh_token',
  'token_expired',
]

for (const alias of NONSTANDARD_INVALID_GRANT_SPELLINGS) {
  test(`a 200 body spelling invalid_grant as ${alias} becomes a 400 invalid_grant`, async () => {
    const response = await normalizeOAuthErrorBody(
      new Response(JSON.stringify({ error: alias }), { status: 200 }),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'invalid_grant',
      error_description: `Server returned non-standard error code: ${alias}`,
    })
  })
}

test('a non-standard alias keeps the description the server sent', async () => {
  const response = await normalizeOAuthErrorBody(
    new Response(
      JSON.stringify({
        error: 'token_expired',
        error_description: 'refresh token was rotated',
      }),
      { status: 200 },
    ),
  )

  assert.deepEqual(await response.json(), {
    error: 'invalid_grant',
    error_description: 'refresh token was rotated',
  })
})

test('an unknown error code is not laundered into invalid_grant', async () => {
  const response = await normalizeOAuthErrorBody(
    new Response(
      JSON.stringify({ error: 'invalid_scope', error_description: 'nope' }),
      { status: 200 },
    ),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'invalid_scope',
    error_description: 'nope',
  })
})

test('a genuine token response is passed through untouched', async () => {
  const body = JSON.stringify({ access_token: 'at', token_type: 'Bearer' })
  const response = await normalizeOAuthErrorBody(
    new Response(body, { status: 200 }),
  )

  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
})

test('a token response is recognized before the error shape is', async () => {
  // OAuthTokensSchema strips unknown keys, so a body carrying real tokens AND
  // an `error` key parses as both. The tokens check has to run first or a
  // successful exchange gets rewritten into a 400.
  const body = JSON.stringify({
    access_token: 'at',
    token_type: 'Bearer',
    error: 'invalid_grant',
  })
  const response = await normalizeOAuthErrorBody(
    new Response(body, { status: 200 }),
  )

  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
})

test('a malformed 200 body is passed through instead of throwing', async () => {
  for (const body of ['', 'not json at all', '<html>maintenance</html>']) {
    const response = await normalizeOAuthErrorBody(
      new Response(body, { status: 200 }),
    )

    assert.equal(response.status, 200)
    assert.equal(await response.text(), body)
  }
})

test('a 200 body of an unrelated shape is passed through', async () => {
  const body = JSON.stringify({ ok: false, reason: 'whatever' })
  const response = await normalizeOAuthErrorBody(
    new Response(body, { status: 200 }),
  )

  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
})

test('an already-failing response is handed back as the same object', async () => {
  // Identity, not shape: the SDK's own error mapping already applies to a
  // non-2xx, so this path must not rebuild the Response at all.
  const original = new Response(JSON.stringify({ error: 'token_expired' }), {
    status: 400,
  })

  assert.equal(await normalizeOAuthErrorBody(original), original)
})

// ── redactSensitiveUrlParams ───────────────────────────────────────────────

/* Spelled out for the same reason as the alias list above. */
const SENSITIVE_PARAMS = [
  'state',
  'nonce',
  'code_challenge',
  'code_verifier',
  'code',
]

for (const param of SENSITIVE_PARAMS) {
  test(`${param} is redacted out of a URL before it reaches a log`, () => {
    const secret = `s3cret-${param}-value`
    const redacted = redactSensitiveUrlParams(
      `https://as.test/authorize?${param}=${secret}&client_id=abc`,
    )

    assert.equal(new URL(redacted).searchParams.get(param), '[REDACTED]')
    assert.ok(!redacted.includes(secret), `leaked ${param}: ${redacted}`)
    assert.equal(new URL(redacted).searchParams.get('client_id'), 'abc')
  })
}

test('redaction does not invent parameters the URL never carried', () => {
  const redacted = redactSensitiveUrlParams(
    'https://as.test/authorize?code=xyz&scope=mcp%3Aread',
  )
  const params = new URL(redacted).searchParams

  assert.equal(params.get('code'), '[REDACTED]')
  assert.equal(params.get('scope'), 'mcp:read')
  for (const absent of ['state', 'nonce', 'code_challenge', 'code_verifier']) {
    assert.equal(params.has(absent), false, `invented ${absent}`)
  }
})

test('a string that is not a URL is returned unchanged, not thrown on', () => {
  assert.equal(redactSensitiveUrlParams('not a url at all'), 'not a url at all')
  assert.equal(redactSensitiveUrlParams(''), '')
})

// ── getServerKey ───────────────────────────────────────────────────────────

const SSE_SERVER: McpSSEServerConfig = {
  type: 'sse',
  url: 'https://mcp.test/sse',
  headers: { 'X-Tenant': 'one' },
}

test('the same server config always yields the same credential key', () => {
  assert.equal(
    getServerKey('srv', SSE_SERVER),
    getServerKey('srv', {
      type: 'sse',
      url: 'https://mcp.test/sse',
      headers: { 'X-Tenant': 'one' },
    }),
  )
})

test('the credential key is the server name plus a 16-hex config digest', () => {
  assert.match(
    getServerKey('my-server', { type: 'sse', url: 'https://mcp.test/sse' }),
    /^my-server\|[0-9a-f]{16}$/,
  )
})

test('anything that changes the server identity changes the key', () => {
  // A collision here hands one server's tokens to another one.
  const key = getServerKey('srv', SSE_SERVER)
  const variants: [string, string][] = [
    ['name', getServerKey('other', SSE_SERVER)],
    [
      'url',
      getServerKey('srv', { ...SSE_SERVER, url: 'https://evil.test/sse' }),
    ],
    [
      'headers',
      getServerKey('srv', { ...SSE_SERVER, headers: { 'X-Tenant': 'two' } }),
    ],
    [
      'transport type',
      getServerKey('srv', {
        type: 'http',
        url: SSE_SERVER.url,
        headers: SSE_SERVER.headers,
      } satisfies McpHTTPServerConfig),
    ],
  ]

  for (const [field, other] of variants) {
    assert.notEqual(other, key, `${field} collides with the base config`)
  }
})

test('absent headers and empty headers are the same server', () => {
  assert.equal(
    getServerKey('srv', { type: 'sse', url: 'https://mcp.test/sse' }),
    getServerKey('srv', {
      type: 'sse',
      url: 'https://mcp.test/sse',
      headers: {},
    }),
  )
})

// ── getScopeFromMetadata ───────────────────────────────────────────────────

type AuthServerMetadata = NonNullable<
  Parameters<typeof getScopeFromMetadata>[0]
>

/* The two winning fields are non-standard, so they are absent from the SDK's
 * type — the whole point of the function is reading them anyway. */
function metadata(fields: Record<string, unknown>): AuthServerMetadata {
  return fields as unknown as AuthServerMetadata
}

test('scope wins over default_scope and over scopes_supported', () => {
  assert.equal(
    getScopeFromMetadata(
      metadata({
        scope: 'from-scope',
        default_scope: 'from-default',
        scopes_supported: ['from-list'],
      }),
    ),
    'from-scope',
  )
})

test('default_scope is used when scope is absent', () => {
  assert.equal(
    getScopeFromMetadata(
      metadata({ default_scope: 'from-default', scopes_supported: ['a'] }),
    ),
    'from-default',
  )
})

test('scopes_supported is space-joined as the standard fallback', () => {
  assert.equal(
    getScopeFromMetadata(metadata({ scopes_supported: ['mcp:read', 'mcp:write'] })),
    'mcp:read mcp:write',
  )
})

test('a non-string scope field falls through instead of being returned', () => {
  assert.equal(
    getScopeFromMetadata(metadata({ scope: 42, scopes_supported: ['mcp:read'] })),
    'mcp:read',
  )
  assert.equal(
    getScopeFromMetadata(
      metadata({ default_scope: ['a'], scopes_supported: ['mcp:read'] }),
    ),
    'mcp:read',
  )
})

test('metadata with no usable scope information yields undefined', () => {
  assert.equal(getScopeFromMetadata(undefined), undefined)
  assert.equal(getScopeFromMetadata(metadata({})), undefined)
  assert.equal(
    getScopeFromMetadata(metadata({ scopes_supported: 'mcp:read' })),
    undefined,
  )
})

// ── AuthenticationCancelledError ───────────────────────────────────────────

test('AuthenticationCancelledError is identifiable by class and by name', () => {
  // performMCPOAuthFlow attributes its failure reason by instanceof, and the
  // MCP menus catch it to distinguish a user cancel from a real failure.
  const error = new AuthenticationCancelledError()

  assert.ok(error instanceof AuthenticationCancelledError)
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'AuthenticationCancelledError')
  assert.equal(error.message, 'Authentication was cancelled')
})

// ── Surface pin — NOT behavioural coverage ─────────────────────────────────
//
// These three assert that the module's shape is intact, nothing about what it
// does. They are the only thing that catches a barrel losing a re-export:
// `bun run build` and `tsc` both pass straight through that hole.

test('src/mcp/auth.js exports exactly the OAuth client surface', () => {
  assert.deepEqual(Object.keys(authModule).sort(), [
    'AuthenticationCancelledError',
    'ClaudeAuthProvider',
    'clearMcpClientConfig',
    'clearServerTokensFromSecureStorage',
    'getFirstOAuthCallbackParam',
    'getScopeFromMetadata',
    'getServerKey',
    'hasMcpDiscoveryButNoToken',
    'normalizeOAuthErrorBody',
    'performMCPOAuthFlow',
    'readClientSecret',
    'redactSensitiveUrlParams',
    'revokeServerTokens',
    'saveMcpClientSecret',
    'validateOAuthCallbackParams',
    'wrapFetchWithStepUpDetection',
  ])
})

test('every export is callable with the arity its callers pass', () => {
  const REQUIRED_ARITY: Record<string, number> = {
    AuthenticationCancelledError: 0,
    ClaudeAuthProvider: 2,
    clearMcpClientConfig: 2,
    clearServerTokensFromSecureStorage: 2,
    getFirstOAuthCallbackParam: 1,
    getScopeFromMetadata: 1,
    getServerKey: 2,
    hasMcpDiscoveryButNoToken: 2,
    normalizeOAuthErrorBody: 1,
    performMCPOAuthFlow: 5,
    readClientSecret: 0,
    redactSensitiveUrlParams: 1,
    revokeServerTokens: 2,
    saveMcpClientSecret: 3,
    validateOAuthCallbackParams: 2,
    wrapFetchWithStepUpDetection: 2,
  }
  const surface = authModule as unknown as Record<string, unknown>

  const actual: Record<string, number> = {}
  for (const name of Object.keys(REQUIRED_ARITY)) {
    const value = surface[name]
    assert.equal(typeof value, 'function', `${name} is not callable`)
    actual[name] = (value as (...args: never[]) => unknown).length
  }

  assert.deepEqual(actual, REQUIRED_ARITY)
})

test('ClaudeAuthProvider still carries the whole OAuthClientProvider contract', () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(ClaudeAuthProvider.prototype).sort(),
    [
      '_doRefresh',
      'authorizationUrl',
      'clientInformation',
      'clientMetadata',
      'clientMetadataUrl',
      'codeVerifier',
      'constructor',
      'discoveryState',
      'invalidateCredentials',
      'markStepUpPending',
      'redirectToAuthorization',
      'redirectUrl',
      'refreshAuthorization',
      'saveClientInformation',
      'saveCodeVerifier',
      'saveDiscoveryState',
      'saveTokens',
      'setMetadata',
      'state',
      'tokens',
    ],
  )
})
