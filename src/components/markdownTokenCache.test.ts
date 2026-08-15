import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __TEST_ONLY_getTokenCacheSize,
  __TEST_ONLY_resetTokenCache,
  cachedLexer,
} from 'src/components/markdownTokenCache.js'

// Content must contain markdown syntax — plain text takes the single-paragraph
// fast path and never touches the cache.
const MD = '# Title\n\nSome **bold** text\n\n- item one\n- item two'

describe('cachedLexer', () => {
  beforeEach(() => {
    __TEST_ONLY_resetTokenCache()
  })

  test('caches lexed tokens by default', () => {
    const first = cachedLexer(MD)
    expect(__TEST_ONLY_getTokenCacheSize()).toBe(1)
    const second = cachedLexer(MD)
    expect(second).toBe(first)
  })

  test('transient lex does not insert into the cache', () => {
    // Streaming-path strings are unique per frame/segment — inserting them
    // would churn reusable history entries out of the LRU.
    const tokens = cachedLexer(MD, true)
    expect(tokens.length).toBeGreaterThan(1)
    expect(__TEST_ONLY_getTokenCacheSize()).toBe(0)
  })

  test('transient lex still returns existing cache hits', () => {
    const cached = cachedLexer(MD)
    const hit = cachedLexer(MD, true)
    expect(hit).toBe(cached)
    expect(__TEST_ONLY_getTokenCacheSize()).toBe(1)
  })

  test('plain text takes the fast path without caching', () => {
    const tokens = cachedLexer('just some plain words with no markdown at all')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.type).toBe('paragraph')
    expect(__TEST_ONLY_getTokenCacheSize()).toBe(0)
  })

  test('CR line endings bypass the fast path (paragraph breaks)', () => {
    // "p1\r\n\r\np2" contains no literal "\n\n", but marked normalizes
    // \r\n (and lone \r) to \n — it IS a paragraph break. The fast path
    // must not collapse it into a single paragraph.
    for (const content of ['p one\r\n\r\np two', 'p one\r\rp two']) {
      const types = cachedLexer(content).map(token => token.type)
      expect(types).toEqual(['paragraph', 'space', 'paragraph'])
    }
  })
})
