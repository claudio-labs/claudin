/**
 * Token endpoints that report a failure with HTTP 200 (Slack does): the
 * response is turned into the 400 RFC 6749 expects, with the vendor spellings
 * of invalid_grant folded into the standard one. Anything else goes through.
 */
import { describe, expect, test } from 'bun:test'
import { normalizeOAuthErrorBody } from 'src/mcp/auth.js'

const reply = (body: string, init: ResponseInit = { status: 200 }) => new Response(body, init)

describe('normalizeOAuthErrorBody', () => {
  test('a successful status carrying an OAuth error becomes a 400 Bad Request', async () => {
    type Case = [label: string, status: number, body: unknown, out: unknown]
    const cases: Case[] = [
      ['invalid_refresh_token', 200, { error: 'invalid_refresh_token' }, { error: 'invalid_grant', error_description: 'Server returned non-standard error code: invalid_refresh_token' }],
      ['expired_refresh_token', 200, { error: 'expired_refresh_token' }, { error: 'invalid_grant', error_description: 'Server returned non-standard error code: expired_refresh_token' }],
      ['token_expired', 200, { error: 'token_expired' }, { error: 'invalid_grant', error_description: 'Server returned non-standard error code: token_expired' }],
      ['alias keeps its own description', 200, { error: 'token_expired', error_description: 'rotated' }, { error: 'invalid_grant', error_description: 'rotated' }],
      ['alias drops its uri', 200, { error: 'token_expired', error_uri: 'https://as.example.test/e' }, { error: 'invalid_grant', error_description: 'Server returned non-standard error code: token_expired' }],
      ['standard code kept', 200, { error: 'invalid_scope', error_description: 'nope' }, { error: 'invalid_scope', error_description: 'nope' }],
      ['standard code keeps its uri', 200, { error: 'invalid_client', error_uri: 'https://as.example.test/e' }, { error: 'invalid_client', error_uri: 'https://as.example.test/e' }],
      ['unknown fields dropped', 200, { error: 'invalid_grant', ok: false }, { error: 'invalid_grant' }],
      ['any 2xx', 201, { error: 'invalid_refresh_token', error_description: 'd' }, { error: 'invalid_grant', error_description: 'd' }],
    ]
    for (const [label, status, body, out] of cases) {
      const res = await normalizeOAuthErrorBody(reply(JSON.stringify(body), { status, headers: { 'X-Trace': 't-1' } }))
      expect([res.status, res.statusText], label).toEqual([400, 'Bad Request'])
      expect(res.headers.get('X-Trace'), label).toBe('t-1')
      expect(await res.json(), label).toEqual(out)
    }
  })

  test('anything that is not an OAuth error keeps its status and its exact body', async () => {
    const bodies = [
      JSON.stringify({ access_token: 'at', token_type: 'Bearer' }),
      JSON.stringify({ access_token: 'at', token_type: 'Bearer', error: 'invalid_grant' }),
      JSON.stringify({ ok: false, reason: 'whatever' }),
      JSON.stringify({ error: 42 }),
      JSON.stringify({ client_id: 'c', redirect_uris: ['http://localhost/cb'] }),
      '',
      'not json at all',
      '<html>maintenance</html>',
    ]
    for (const body of bodies) {
      const res = await normalizeOAuthErrorBody(reply(body, { status: 200, statusText: 'OK', headers: { 'X-Trace': 't-2' } }))
      expect([res.status, res.statusText, res.headers.get('X-Trace')], body).toEqual([200, 'OK', 't-2'])
      expect(await res.text(), body).toBe(body)
    }
  })

  test('a response that already failed is handed back as the very same object, unread', async () => {
    for (const status of [400, 401, 500]) {
      const original = reply(JSON.stringify({ error: 'token_expired' }), { status })
      const res = await normalizeOAuthErrorBody(original)
      expect(res, String(status)).toBe(original)
      expect(res.bodyUsed, String(status)).toBe(false)
    }
  })
})
