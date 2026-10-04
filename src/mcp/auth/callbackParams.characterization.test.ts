/**
 * The browser's redirect back to the loopback callback: which value of a
 * repeated parameter counts, the order in which state, error and code are
 * judged, and what a URL looks like once it is safe to log.
 */
import { describe, expect, test } from 'bun:test'
import {
  getFirstOAuthCallbackParam,
  redactSensitiveUrlParams,
  validateOAuthCallbackParams,
} from 'src/mcp/auth.js'

const STATE = 'expected-state'

describe('getFirstOAuthCallbackParam', () => {
  test('the first non-empty value wins; absent and empty are undefined', () => {
    const cases: [input: string | string[] | null | undefined, out: string | undefined][] = [
      ['code', 'code'],
      ['', undefined],
      [null, undefined],
      [undefined, undefined],
      [['first', 'second'], 'first'],
      [['', 'second'], 'second'],
      [['', ''], undefined],
      [[], undefined],
    ]
    for (const [input, out] of cases) expect(getFirstOAuthCallbackParam(input), JSON.stringify(input)).toBe(out)
  })
})

describe('validateOAuthCallbackParams', () => {
  test('state is judged before anything else, so no error or code gets past a mismatch', () => {
    const rejected: Parameters<typeof validateOAuthCallbackParams>[0][] = [
      { code: 'c' },
      { error: 'access_denied', error_description: 'no' },
      { state: 'forged', code: 'c' },
      { state: ['forged', STATE], code: 'c' },
      { state: '', code: 'c' },
      { state: [STATE.toUpperCase()], code: 'c' },
    ]
    for (const params of rejected) {
      expect(validateOAuthCallbackParams(params, STATE), JSON.stringify(params)).toEqual({ type: 'state_mismatch' })
    }
  })

  test('an expected state that is empty never matches', () => {
    for (const state of [undefined, '', ['']]) {
      expect(validateOAuthCallbackParams({ state, code: 'c' }, '')).toEqual({ type: 'state_mismatch' })
    }
  })

  test('with the state right: an error first, then a code, else nothing came back', () => {
    type Case = [label: string, params: Parameters<typeof validateOAuthCallbackParams>[0], out: unknown]
    const cases: Case[] = [
      ['code', { state: STATE, code: 'auth-code' }, { type: 'code', code: 'auth-code' }],
      ['repeated state, real one first', { state: ['', STATE, 'x'], code: ['', 'c2'] }, { type: 'code', code: 'c2' }],
      ['nothing', { state: STATE }, { type: 'missing_result' }],
      ['empty code', { state: STATE, code: '' }, { type: 'missing_result' }],
      [
        'full error',
        { state: STATE, error: 'access_denied', error_description: 'denied by provider', error_uri: 'https://as.example.test/e' },
        { type: 'error', error: 'access_denied', errorDescription: 'denied by provider', errorUri: 'https://as.example.test/e', message: 'OAuth error: access_denied - denied by provider (See: https://as.example.test/e)' },
      ],
      ['bare error', { state: STATE, error: 'server_error' }, { type: 'error', error: 'server_error', errorDescription: '', errorUri: '', message: 'OAuth error: server_error' }],
      ['error with uri only', { state: STATE, error: 'x', error_uri: 'u' }, { type: 'error', error: 'x', errorDescription: '', errorUri: 'u', message: 'OAuth error: x (See: u)' }],
      ['error beats code', { state: STATE, error: 'x', error_description: 'd', code: 'c' }, { type: 'error', error: 'x', errorDescription: 'd', errorUri: '', message: 'OAuth error: x - d' }],
      ['empty error is no error', { state: STATE, error: '', code: 'c' }, { type: 'code', code: 'c' }],
    ]
    for (const [label, params, out] of cases) expect(validateOAuthCallbackParams(params, STATE) as unknown, label).toEqual(out)
  })
})

describe('redactSensitiveUrlParams', () => {
  test('each sensitive parameter is masked, and the others survive', () => {
    for (const param of ['state', 'nonce', 'code_challenge', 'code_verifier', 'code']) {
      const secret = `s3cret-${param}`
      const out = redactSensitiveUrlParams(`https://as.example.test/authorize?${param}=${secret}&client_id=abc&scope=mcp%3Aread`)
      const parsed = new URL(out).searchParams
      expect(out, param).not.toContain(secret)
      expect(parsed.get(param), param).toBe('[REDACTED]')
      expect([parsed.get('client_id'), parsed.get('scope')], param).toEqual(['abc', 'mcp:read'])
    }
  })

  test('the exact text a log gets', () => {
    const cases: [input: string, out: string][] = [
      ['https://as.example.test/authorize?code=xyz&scope=mcp%3Aread', 'https://as.example.test/authorize?code=%5BREDACTED%5D&scope=mcp%3Aread'],
      ['https://as.example.test?state=a&state=b&x=1', 'https://as.example.test/?state=%5BREDACTED%5D&x=1'],
      ['https://as.example.test/cb?error=denied', 'https://as.example.test/cb?error=denied'],
      ['http://localhost:1234/callback#code=frag', 'http://localhost:1234/callback#code=frag'],
      ['not a url at all', 'not a url at all'],
      ['', ''],
    ]
    for (const [input, out] of cases) expect(redactSensitiveUrlParams(input), input).toBe(out)
  })
})
