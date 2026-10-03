/**
 * Characterization of `parseSessionIdentifier`: what `-p --resume <value>`
 * accepts. A transcript file, a session id, or a session-ingress URL; nothing
 * else.
 */
import { describe, expect, test } from 'bun:test'
import { parseSessionIdentifier } from 'src/sessions/sessionUrl.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('a transcript file', () => {
  const files = [
    '/home/me/.claudin/projects/x/2b7f.jsonl',
    'relative/run.jsonl',
    'C:\\Users\\me\\logs\\run.JSONL',
    'https://example.com/v1/session_ingress/session/550e8400-e29b-41d4-a716-446655440000.jsonl',
    '.jsonl',
  ]

  test.each(files)('%s is read as a file path, kept as given', input => {
    const parsed = parseSessionIdentifier(input)!
    expect(parsed).toMatchObject({ isJsonlFile: true, jsonlFile: input, isUrl: false, ingressUrl: null })
    expect(parsed.sessionId).toMatch(UUID)
  })

  test('each parse gets a session id of its own', () => {
    const a = parseSessionIdentifier('run.jsonl')!
    const b = parseSessionIdentifier('run.jsonl')!
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  test('only the extension counts: run.jsonl.bak is not a transcript', () => {
    expect(parseSessionIdentifier('run.jsonl.bak')).toBeNull()
  })
})

describe('a session id', () => {
  const ids = [
    '550e8400-e29b-41d4-a716-446655440000',
    '550E8400-E29B-41D4-A716-446655440000',
    '00000000-0000-0000-0000-000000000000',
  ]

  test.each(ids)('%s is resumed under that id', id => {
    expect(parseSessionIdentifier(id)).toEqual({
      sessionId: id as never,
      ingressUrl: null,
      isUrl: false,
      jsonlFile: null,
      isJsonlFile: false,
    })
  })
})

describe('a URL', () => {
  const urls: Array<[string, string]> = [
    [
      'https://api.example.com/v1/session_ingress/session/550e8400-e29b-41d4-a716-446655440000',
      'https://api.example.com/v1/session_ingress/session/550e8400-e29b-41d4-a716-446655440000',
    ],
    ['HTTPS://API.Example.COM/v1/x?y=1#z', 'https://api.example.com/v1/x?y=1#z'],
    ['http://localhost:8080', 'http://localhost:8080/'],
  ]

  test.each(urls)('%s is the ingress URL, normalized', (input, href) => {
    const parsed = parseSessionIdentifier(input)!
    expect(parsed).toMatchObject({ isUrl: true, ingressUrl: href, isJsonlFile: false, jsonlFile: null })
    expect(parsed.sessionId).toMatch(UUID)
  })

  test('the session id is never taken from the URL', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    expect(parseSessionIdentifier(`https://api.example.com/session/${id}`)!.sessionId).not.toBe(id)
  })
})

describe('anything else', () => {
  const rejected = [
    '',
    'my-session',
    'session_01abc',
    '550e8400-e29b-41d4-a716-44665544000',
    '550e8400e29b41d4a716446655440000',
    ' 550e8400-e29b-41d4-a716-446655440000',
    '/tmp/run.json',
    'https://',
  ]

  test.each(rejected)('%p is not a session identifier', input => {
    expect(parseSessionIdentifier(input)).toBeNull()
  })
})
