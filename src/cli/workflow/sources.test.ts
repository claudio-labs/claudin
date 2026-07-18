import { describe, expect, test } from 'bun:test'

import { parseFeed, parseUrlTriggers } from './sources.js'

const URL = 'https://example.com/feed'

describe('parseUrlTriggers — JSON feed', () => {
  test('array of strings → one task per string', () => {
    const items = parseUrlTriggers(URL, JSON.stringify(['do X', 'do Y']))
    expect(items).toHaveLength(2)
    expect(items[0]!.title).toBe('do X')
    expect(items[0]!.body).toBe('do X')
  })

  test('array of objects uses title/body with fallbacks', () => {
    const items = parseUrlTriggers(
      URL,
      JSON.stringify([
        { id: 7, title: 'Fix bug', body: 'the details' },
        { task: 'Refactor the parser' },
      ]),
    )
    expect(items[0]!.id).toBe('url#7')
    expect(items[0]!.title).toBe('Fix bug')
    expect(items[0]!.body).toBe('the details')
    expect(items[1]!.title).toBe('Refactor the parser')
    expect(items[1]!.body).toBe('Refactor the parser')
  })

  test('{tasks:[…]} and {items:[…]} wrappers are unwrapped', () => {
    expect(
      parseUrlTriggers(URL, JSON.stringify({ tasks: ['a'] })),
    ).toHaveLength(1)
    expect(
      parseUrlTriggers(URL, JSON.stringify({ items: ['a', 'b'] })),
    ).toHaveLength(2)
  })

  test('drops empty/blank elements', () => {
    const items = parseUrlTriggers(URL, JSON.stringify(['', '   ', {}, 'real']))
    expect(items.map(i => i.title)).toEqual(['real'])
  })

  test('object items without an id get a content-hash id', () => {
    const items = parseUrlTriggers(URL, JSON.stringify([{ title: 'no id here' }]))
    expect(items[0]!.id).toMatch(/^url:[0-9a-f]{12}$/)
  })
})

describe('parseUrlTriggers — content-change fallback', () => {
  test('non-feed text becomes a single hash-keyed trigger', () => {
    const items = parseUrlTriggers(URL, '<html>deploy v2 now</html>')
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toMatch(/^url:[0-9a-f]{12}$/)
    expect(items[0]!.title).toBe(`Update from ${URL}`)
    expect(items[0]!.body).toBe('<html>deploy v2 now</html>')
  })

  test('same content → same id (deduped); changed content → new id', () => {
    const a = parseUrlTriggers(URL, 'same page')[0]!
    const aAgain = parseUrlTriggers(URL, 'same page')[0]!
    const b = parseUrlTriggers(URL, 'changed page')[0]!
    expect(a.id).toBe(aAgain.id)
    expect(a.id).not.toBe(b.id)
  })

  test('empty body yields no triggers', () => {
    expect(parseUrlTriggers(URL, '')).toEqual([])
    expect(parseUrlTriggers(URL, '   \n')).toEqual([])
  })

  test('malformed JSON falls back to a content trigger', () => {
    const items = parseUrlTriggers(URL, '{not valid json')
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toMatch(/^url:/)
  })
})

describe('parseFeed — kind prefixes the ids (source isolation)', () => {
  test('command source ids use the "cmd" prefix, never colliding with url', () => {
    const cmd = parseFeed('cmd', 'Output of `x`', JSON.stringify(['do X']))
    const url = parseUrlTriggers(URL, JSON.stringify(['do X']))
    expect(cmd[0]!.id).toMatch(/^cmd:/)
    expect(url[0]!.id).toMatch(/^url:/)
    expect(cmd[0]!.id).not.toBe(url[0]!.id)
  })

  test('command content-change trigger uses the change title and cmd id', () => {
    const items = parseFeed('cmd', 'Output of `check.sh`', 'v2 ready\n')
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toMatch(/^cmd:[0-9a-f]{12}$/)
    expect(items[0]!.title).toBe('Output of `check.sh`')
    expect(items[0]!.body).toBe('v2 ready')
  })

  test('object id uses the kind prefix (cmd#<id>)', () => {
    const items = parseFeed('cmd', 't', JSON.stringify([{ id: 5, task: 'go' }]))
    expect(items[0]!.id).toBe('cmd#5')
  })
})
