/**
 * The `src/mcp/auth.js` barrel: the names it carries, the arity callers pass,
 * and the two small pieces of the provider and the flow that no other suite
 * pins on their own (the scope picked from server metadata, and the cancel
 * error's identity). A barrel that loses a re-export still builds and
 * typechecks, so this is the only net for that.
 */
import { describe, expect, test } from 'bun:test'
import * as barrel from 'src/mcp/auth.js'
import { AuthenticationCancelledError, ClaudeAuthProvider, getScopeFromMetadata } from 'src/mcp/auth.js'

describe('the barrel', () => {
  test('carries exactly these names, each callable with the arity its callers use', () => {
    const arity: Record<string, number> = {
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
    const surface = barrel as unknown as Record<string, (...a: never[]) => unknown>
    expect(Object.keys(barrel).sort()).toEqual(Object.keys(arity).sort())
    expect(Object.fromEntries(Object.keys(arity).map(n => [n, typeof surface[n] === 'function' ? surface[n].length : -1]))).toEqual(arity)
  })

  test('ClaudeAuthProvider answers every OAuthClientProvider method the SDK and the transport call', () => {
    const methods = Object.getOwnPropertyNames(ClaudeAuthProvider.prototype)
    for (const name of [
      'authorizationUrl', 'clientInformation', 'clientMetadata', 'clientMetadataUrl', 'codeVerifier',
      'discoveryState', 'invalidateCredentials', 'markStepUpPending', 'redirectToAuthorization', 'redirectUrl',
      'refreshAuthorization', 'saveClientInformation', 'saveCodeVerifier', 'saveDiscoveryState', 'saveTokens',
      'setMetadata', 'state', 'tokens',
    ]) {
      expect(methods, name).toContain(name)
    }
  })
})

describe('getScopeFromMetadata', () => {
  type Meta = NonNullable<Parameters<typeof getScopeFromMetadata>[0]>
  const meta = (fields: Record<string, unknown>) => fields as unknown as Meta

  test('scope, then default_scope, then scopes_supported joined by spaces', () => {
    const cases: [fields: Record<string, unknown> | undefined, out: string | undefined][] = [
      [{ scope: 'a', default_scope: 'b', scopes_supported: ['c'] }, 'a'],
      [{ default_scope: 'b', scopes_supported: ['c'] }, 'b'],
      [{ scopes_supported: ['mcp:read', 'mcp:write'] }, 'mcp:read mcp:write'],
      [{ scope: 42, scopes_supported: ['c'] }, 'c'],
      [{ default_scope: ['b'], scopes_supported: ['c'] }, 'c'],
      [{ scopes_supported: 'mcp:read' }, undefined],
      [{}, undefined],
      [undefined, undefined],
    ]
    for (const [fields, out] of cases) {
      expect(getScopeFromMetadata(fields === undefined ? undefined : meta(fields)), JSON.stringify(fields)).toBe(out)
    }
  })
})

describe('AuthenticationCancelledError', () => {
  test('is an Error recognisable by class, name and message', () => {
    const err = new AuthenticationCancelledError()
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AuthenticationCancelledError)
    expect([err.name, err.message]).toEqual(['AuthenticationCancelledError', 'Authentication was cancelled'])
  })
})
