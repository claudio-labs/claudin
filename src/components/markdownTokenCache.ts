import { marked, type Token } from 'marked'
import { hashContent } from '../utils/hash.js'

// Module-level token cache — marked.lexer is the hot cost on virtual-scroll
// remounts (~3ms per message). useMemo doesn't survive unmount→remount, so
// scrolling back to a previously-visible message re-parses. Messages are
// immutable in history; same content → same tokens. Keyed by hash to avoid
// retaining full content strings (turn50→turn99 RSS regression, #24180).
const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, Token[]>()

// Characters that indicate markdown syntax. If none are present, skip the
// ~3ms marked.lexer call entirely — render as a single paragraph. Single
// regex: matches any MD marker, ordered-list start (N. at line start), or a
// paragraph break. \r is included because marked normalizes \r\n and lone \r
// to \n before tokenizing — "p1\r\n\r\np2" has no literal "\n\n", but IS a
// paragraph break, and the fast path would collapse it onto one line.
const MD_SYNTAX_RE = /[#*`|[>\-_~\r]|\n\n|^\d+\. |\n\d+\. /

function hasMarkdownSyntax(s: string): boolean {
  // Sample first 500 chars — if markdown exists it's usually early (headers,
  // code fence, list). Long tool outputs are mostly plain text tails.
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

export function cachedLexer(content: string, transient = false): Token[] {
  // Fast path: plain text with no markdown syntax → single paragraph token.
  // Skips marked.lexer's full GFM parse (~3ms on long content). Not cached —
  // reconstruction is a single object allocation, and caching would retain
  // 4× content in raw/text fields plus the hash key for zero benefit.
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [
          {
            type: 'text',
            raw: content,
            text: content,
          },
        ],
      } as Token,
    ]
  }
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) {
    // Promote to MRU — without this the eviction is FIFO (scrolling back to
    // an early message evicts the very item you're looking at).
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit
  }
  const tokens = marked.lexer(content)
  // Transient content (streaming suffix/segments) is a unique string on
  // every frame or block boundary — inserting it would flush genuinely
  // reusable history entries out of the LRU during a long stream, forcing
  // re-parses when the user scrolls back. Lex without caching.
  if (transient) {
    return tokens
  }
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    // LRU-ish: drop oldest. Map preserves insertion order.
    const first = tokenCache.keys().next().value
    if (first !== undefined) tokenCache.delete(first)
  }
  tokenCache.set(key, tokens)
  return tokens
}

/** Test-only accessor for the module-private tokenCache size. */
export function __TEST_ONLY_getTokenCacheSize(): number {
  return tokenCache.size
}

/** Test-only reset for tokenCache. */
export function __TEST_ONLY_resetTokenCache(): void {
  tokenCache.clear()
}
