import emojiRegex from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from 'src/shared/text/intl.js'

const EMOJI_REGEX = emojiRegex()

// Emoji PRESENTATION, which is a different question from "is this an emoji".
// Tested against the START of a grapheme: U+FE0F and the enclosing keycap are
// checked separately below, because they TRAIL the base character.
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}/u

/**
 * Fallback JavaScript implementation of stringWidth when Bun.stringWidth is not
 * available — which is every run under Node (`node dist/cli.mjs`), so this is
 * not a rarely-taken branch. Exported for the test: `stringWidth` below binds to
 * Bun's under `bun test`, and nothing would otherwise exercise this one.
 *
 * Get the display width of a string as it would appear in a terminal.
 *
 * Two rules do the work. Ambiguous-width characters are narrow
 * (`ambiguousAsWide: false`), which is what the Unicode standard recommends for
 * Western contexts. And a grapheme is 2 cells only when it is actually PAINTED
 * as an emoji — `emoji-regex` matches text-presentation emoji too, and a
 * terminal draws those in ONE cell. ⚠ (U+26A0) is the character this comment
 * named as the fixed case while the code still returned 2 for it; ✔ (U+2714)
 * and ▶ (U+25B6) are the two the TUI paints most.
 *
 * Over-measuring by one is not cosmetic: it puts the model a column to the right
 * of the terminal for the rest of the row, and the next partial repaint writes
 * that row's tail one cell over, duplicating a character at the seam
 * (.claudin/rules/ink-tui.md §3(b)).
 */
// Kitty Unicode Placeholder (U+10EEEE) carries 3 combining diacritics from a
// 297-entry table; some entries fall outside the U+0305..U+036F range that
// stringWidth would otherwise treat as zero-width, which would cause the
// cell grid to allocate 2 cells per placeholder and break image layout.
// Each U+10EEEE occupies exactly 1 cell regardless of its diacritics.
//
// We must handle MIXED strings (text + placeholders) correctly: strip the
// placeholder + its (up to 3) trailing diacritics, count those cells
// separately, and measure the surrounding text with the normal path. The
// regex matches U+10EEEE followed by 0–3 combining marks of any class.
const KITTY_PLACEHOLDER_CHAR = '\u{10EEEE}'
const KITTY_PLACEHOLDER_CLUSTER_RE = /\u{10EEEE}\p{M}{0,3}/gu

/**
 * Returns `{ count, stripped }` where `count` is the number of placeholders
 * in `str` and `stripped` is `str` with each placeholder-cluster removed.
 * The two together let the caller compute width as `count + width(stripped)`.
 */
function extractKittyPlaceholders(str: string): {
  count: number
  stripped: string
} {
  let count = 0
  const stripped = str.replace(KITTY_PLACEHOLDER_CLUSTER_RE, () => {
    count++
    return ''
  })
  return { count, stripped }
}

export function stringWidthJavaScript(str: string): number {
  if (typeof str !== 'string' || str.length === 0) {
    return 0
  }

  if (str.includes(KITTY_PLACEHOLDER_CHAR)) {
    const { count, stripped } = extractKittyPlaceholders(str)
    // Recurse on the stripped text (no placeholders left → normal path).
    return count + stringWidthJavaScript(stripped)
  }

  // Fast path: pure ASCII string (no ANSI codes, no wide chars)
  let isPureAscii = true
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    // Check for non-ASCII or ANSI escape (0x1b)
    if (code >= 127 || code === 0x1b) {
      isPureAscii = false
      break
    }
  }
  if (isPureAscii) {
    // Count printable characters (exclude control chars)
    let width = 0
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code > 0x1f) {
        width++
      }
    }
    return width
  }

  // Strip ANSI if escape character is present
  if (str.includes('\x1b')) {
    str = stripAnsi(str)
    if (str.length === 0) {
      return 0
    }
  }

  // Fast path: simple Unicode (no emoji, variation selectors, or joiners)
  if (!needsSegmentation(str)) {
    let width = 0
    for (const char of str) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false })
      }
    }
    return width
  }

  let width = 0

  for (const { segment: grapheme } of getGraphemeSegmenter().segment(str)) {
    // Emoji first — but only the ones drawn AS emoji. Matching `EMOJI_REGEX`
    // alone sends every text-presentation emoji down here too, and across the
    // ranges `needsSegmentation` routes to this loop that was 175 codepoints
    // measured at 2 which the terminal paints in 1.
    EMOJI_REGEX.lastIndex = 0
    if (EMOJI_REGEX.test(grapheme) && rendersAsEmoji(grapheme)) {
      width += getEmojiWidth(grapheme)
      continue
    }

    // Calculate width for non-emoji graphemes
    // For grapheme clusters (like Devanagari conjuncts with virama+ZWJ), only count
    // the first non-zero-width character's width since the cluster renders as one glyph
    for (const char of grapheme) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false })
        break
      }
    }
  }

  return width
}

function needsSegmentation(str: string): boolean {
  for (const char of str) {
    const cp = char.codePointAt(0)!
    // Emoji ranges
    if (cp >= 0x1f300 && cp <= 0x1faff) return true
    if (cp >= 0x2600 && cp <= 0x27bf) return true
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true
    // Variation selectors, ZWJ
    if (cp >= 0xfe00 && cp <= 0xfe0f) return true
    if (cp === 0x200d) return true
    // Combining enclosing keycap. Without this a bare `1⃣` (no VS16) skips the
    // grapheme loop and measures 1, while the same keycap inside a string that
    // does segment measures 2 — the mark is what makes it a keycap either way.
    if (cp === 0x20e3) return true
  }
  return false
}

function getEmojiWidth(grapheme: string): number {
  // Regional indicators: single = 1, pair = 2
  const first = grapheme.codePointAt(0)!
  if (first >= 0x1f1e6 && first <= 0x1f1ff) {
    let count = 0
    for (const _ of grapheme) count++
    return count === 1 ? 1 : 2
  }

  // Incomplete keycap: digit/symbol + VS16 without U+20E3
  if (grapheme.length === 2) {
    const second = grapheme.codePointAt(1)
    if (
      second === 0xfe0f &&
      ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)
    ) {
      return 1
    }
  }

  return 2
}

/**
 * Whether a grapheme `EMOJI_REGEX` matched is painted as an emoji (2 cells)
 * rather than as text (1 cell).
 *
 * The two marks are looked for across the whole grapheme because they follow the
 * base character: VS16 requests emoji presentation explicitly, and the combining
 * enclosing keycap (U+20E3) makes a keycap out of a digit that carries no
 * presentation of its own. `Emoji_Presentation` covers everything that LEADS
 * with a presentation-default character, which is what flags, skin-tone
 * sequences and ZWJ families all do.
 */
function rendersAsEmoji(grapheme: string): boolean {
  return (
    grapheme.includes('\uFE0F') ||
    grapheme.includes('\u20E3') ||
    EMOJI_PRESENTATION_RE.test(grapheme)
  )
}

function isZeroWidth(codePoint: number): boolean {
  // Fast path for common printable range
  if (codePoint >= 0x20 && codePoint < 0x7f) return false
  if (codePoint >= 0xa0 && codePoint < 0x0300) return codePoint === 0x00ad

  // Control characters
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true

  // Zero-width and invisible characters
  if (
    (codePoint >= 0x200b && codePoint <= 0x200d) || // ZW space/joiner
    codePoint === 0xfeff || // BOM
    (codePoint >= 0x2060 && codePoint <= 0x2064) // Word joiner etc.
  ) {
    return true
  }

  // Variation selectors
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true
  }

  // Combining diacritical marks
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return true
  }

  // Indic script combining marks (covers Devanagari through Malayalam)
  if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
    // Signs and vowel marks at start of each script block
    const offset = codePoint & 0x7f
    if (offset <= 0x03) return true // Signs at block start
    if (offset >= 0x3a && offset <= 0x4f) return true // Vowel signs, virama
    if (offset >= 0x51 && offset <= 0x57) return true // Stress signs
    if (offset >= 0x62 && offset <= 0x63) return true // Vowel signs
  }

  // Thai/Lao combining marks
  // Note: U+0E32 (SARA AA), U+0E33 (SARA AM), U+0EB2, U+0EB3 are spacing vowels (width 1), not combining marks
  if (
    codePoint === 0x0e31 || // Thai MAI HAN-AKAT
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) || // Thai vowel signs (skip U+0E32, U+0E33)
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) || // Thai vowel signs and marks
    codePoint === 0x0eb1 || // Lao MAI KAN
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) || // Lao vowel signs (skip U+0EB2, U+0EB3)
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) // Lao tone marks
  ) {
    return true
  }

  // Arabic formatting
  if (
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2
  ) {
    return true
  }

  // Surrogates, tag characters
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true

  return false
}

// Note: complex-script graphemes like Devanagari क्ष (ka+virama+ZWJ+ssa) render
// as a single ligature glyph but occupy 2 terminal cells (wcwidth sums the base
// consonants). Bun.stringWidth=2 matches terminal cell allocation, which is what
// we need for cursor positioning — the JS fallback's grapheme-cluster width of 1
// would desync Ink's layout from the terminal.
//
// Bun.stringWidth is resolved once at module scope rather than checked on every
// call — typeof guards deopt property access and this is a hot path (~100k calls/frame).
const bunStringWidth =
  typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
    ? Bun.stringWidth
    : null

const BUN_STRING_WIDTH_OPTS = { ambiguousIsNarrow: true } as const

export const stringWidth: (str: string) => number = bunStringWidth
  ? str => {
      if (str.includes(KITTY_PLACEHOLDER_CHAR)) {
        const { count, stripped } = extractKittyPlaceholders(str)
        return (
          count +
          (stripped.length > 0
            ? bunStringWidth(stripped, BUN_STRING_WIDTH_OPTS)
            : 0)
        )
      }
      return bunStringWidth(str, BUN_STRING_WIDTH_OPTS)
    }
  : stringWidthJavaScript
