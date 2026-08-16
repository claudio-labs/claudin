import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __TEST_ONLY_getTokenCacheSize,
  __TEST_ONLY_resetTokenCache,
  cachedLexer,
} from 'src/terminal/markdown/markdownTokenCache.js'

// Content must contain markdown syntax — plain text takes the single-paragraph
// fast path and never touches the cache.
const MD = '# Title\n\nSome **bold** text\n\n- item one\n- item two'

// A second markdown string, used to evict the one-slot memo between calls so
// the assertions below exercise the LRU rather than the slot.
const OTHER = '## Other\n\nA different **paragraph** entirely'

describe('cachedLexer', () => {
  beforeEach(() => {
    __TEST_ONLY_resetTokenCache()
  })

  test('caches lexed tokens by default', () => {
    const first = cachedLexer(MD)
    expect(__TEST_ONLY_getTokenCacheSize()).toBe(1)
    // Bust the one-slot memo, or the identity below would prove nothing about
    // the LRU — the slot alone would satisfy it.
    cachedLexer(OTHER)
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
    cachedLexer(OTHER)
    const hit = cachedLexer(MD, true)
    expect(hit).toBe(cached)
    expect(__TEST_ONLY_getTokenCacheSize()).toBe(2)
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

  describe('one-slot memo', () => {
    // StreamingMarkdown lexes the unstable suffix twice per frame — once for
    // the segment-cut arithmetic (Markdown.tsx:204), once to render it
    // (Markdown.tsx:93). Both calls are transient, so the LRU never catches
    // the repeat; only the slot does. Token identity is the observable proof
    // that the second call did not re-lex.
    test('repeats the same transient string without lexing twice', () => {
      const first = cachedLexer(MD, true)
      const second = cachedLexer(MD, true)
      expect(second).toBe(first)
      expect(__TEST_ONLY_getTokenCacheSize()).toBe(0)
    })

    test('a different string evicts the slot', () => {
      // The slot holds exactly one entry: going back to MD after OTHER must
      // re-lex (not the original array), and only then start repeating again.
      // The second half is what fails if the slot stops working — without it
      // this assertion would hold trivially, since two separate lexes always
      // produce two different arrays.
      const first = cachedLexer(MD, true)
      cachedLexer(OTHER, true)
      const third = cachedLexer(MD, true)
      const fourth = cachedLexer(MD, true)
      expect(third).not.toBe(first)
      expect(fourth).toBe(third)
    })

    test('a long run of distinct transient strings never touches the LRU', () => {
      // The streaming case: every frame is a slightly longer string. The slot
      // must absorb the intra-frame repeat without leaking any of them into
      // the LRU, which exists for immutable history messages. This one stays
      // green if the slot is disabled (transient never inserts anyway) — it
      // guards the opposite mutation: a `remember` that also wrote to the LRU.
      for (let i = 1; i <= 50; i++) {
        const frame = `${MD}\n\nframe ${i}`
        cachedLexer(frame, true)
        cachedLexer(frame, true)
      }
      expect(__TEST_ONLY_getTokenCacheSize()).toBe(0)
    })

    test('also covers the plain-text fast path', () => {
      const plain = 'just some plain words with no markdown at all'
      const first = cachedLexer(plain)
      const second = cachedLexer(plain)
      expect(second).toBe(first)
      expect(__TEST_ONLY_getTokenCacheSize()).toBe(0)
    })
  })
})
