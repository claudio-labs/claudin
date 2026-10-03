/**
 * The fix of finding 6 in the `sessions/remote` spec: only a web address is an
 * ingress URL. Anything else the WHATWG parser happens to accept used to start
 * an empty session under `-p --resume`; it is now refused, so the caller
 * reports an invalid id.
 */
import { describe, expect, test } from 'bun:test'
import { parseSessionIdentifier } from 'src/sessions/sessionUrl.js'

describe('only http: and https: are ingress URLs', () => {
  const refused = [
    'foo:bar',
    'C:\\x\\file.txt',
    'file:///home/me/run.txt',
    'ftp://example.com/session',
    'wss://api.example.com/v1/sessions/ws/abc/subscribe',
    'javascript:alert(1)',
    'mailto:me@example.com',
  ]

  test.each(refused)('%p is not a session identifier', input => {
    expect(parseSessionIdentifier(input)).toBeNull()
  })

  test.each(['http://127.0.0.1:9/x', 'HtTpS://example.com'])('%p still is', input => {
    expect(parseSessionIdentifier(input)).toMatchObject({ isUrl: true })
  })

  test('a refused scheme that ends in .jsonl is still a transcript file', () => {
    expect(parseSessionIdentifier('file:///tmp/run.jsonl')).toMatchObject({
      isJsonlFile: true,
      jsonlFile: 'file:///tmp/run.jsonl',
    })
  })
})
