import { marked, type Token } from 'marked'
import { hashContent } from 'src/shared/data/hash.js'

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

// One-slot memo for the same string lexed twice within one frame.
// StreamingMarkdown lexes the unstable suffix at Markdown.tsx:204 purely to
// find the segment cut point, throws those tokens away, then renders that same
// suffix through <Markdown transient>, which arrives back here and lexes it
// again — `transient` skips only the LRU insert, not the lex.
//
// Measured over a simulated 20 KB reply at the real 16 ms frame cadence: the
// two strings are identical on 98.9% (prose) to 99.9% (code) of frames, the
// misses being exactly the frames where the boundary advances.
//
// What the repo's bench reproduces is the call count — real lexer invocations
// per frame drop from ~1.98 to ~1.03 with byte-identical output
// (`scripts/bench/perf/streaming-bench.ts`; `--direct-boundary` is the
// before-side). It does NOT resolve a wall-clock win, because its fixtures are
// 1-1.5 KB over fewer than 60 frames while the saving scales with size ×
// frame count. Don't quote a millisecond figure from it.
//
// Deliberately NOT the LRU above: streaming strings are unique per frame, so
// inserting them is what the `transient` flag exists to prevent.
let lastContent: string | null = null
let lastTokens: Token[] | null = null

function remember(content: string, tokens: Token[]): Token[] {
  lastContent = content
  lastTokens = tokens
  return tokens
}

export function cachedLexer(content: string, transient = false): Token[] {
  // Checked before everything else, including the plain-text fast path, since
  // that path still rebuilds a token object on every call.
  if (lastContent === content && lastTokens !== null) {
    return lastTokens
  }
  // Fast path: plain text with no markdown syntax → single paragraph token.
  // Skips marked.lexer's full GFM parse (~3ms on long content). Not cached —
  // reconstruction is a single object allocation, and caching would retain
  // 4× content in raw/text fields plus the hash key for zero benefit.
  if (!hasMarkdownSyntax(content)) {
    return remember(content, [
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
    ])
  }
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) {
    // Promote to MRU — without this the eviction is FIFO (scrolling back to
    // an early message evicts the very item you're looking at).
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return remember(content, hit)
  }
  const tokens = marked.lexer(content)
  // Transient content (streaming suffix/segments) is a unique string on
  // every frame or block boundary — inserting it would flush genuinely
  // reusable history entries out of the LRU during a long stream, forcing
  // re-parses when the user scrolls back. Lex without caching.
  if (transient) {
    return remember(content, tokens)
  }
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    // LRU-ish: drop oldest. Map preserves insertion order.
    const first = tokenCache.keys().next().value
    if (first !== undefined) tokenCache.delete(first)
  }
  tokenCache.set(key, tokens)
  return remember(content, tokens)
}

/** Test-only accessor for the module-private tokenCache size. */
export function __TEST_ONLY_getTokenCacheSize(): number {
  return tokenCache.size
}

/** Test-only reset for tokenCache. */
export function __TEST_ONLY_resetTokenCache(): void {
  tokenCache.clear()
  lastContent = null
  lastTokens = null
}
