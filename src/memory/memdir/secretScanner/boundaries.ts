/**
 * Where a credential may start and stop. A family's pattern describes only
 * the token; its boundary decides what may stand around it.
 */

export type TokenBoundary =
  /** Anywhere, even inside a longer run or glued to a word. */
  | { kind: 'anywhere' }
  /** A word boundary on both sides: any punctuation ends the token. */
  | { kind: 'word' }
  /** A word boundary before the token, nothing required after it. */
  | { kind: 'wordStart' }
  /**
   * A word boundary before, and no token character after. Letters, digits,
   * `_` and `-` always continue a token; `continuedBy` adds the family's own
   * alphabet (base64 `+/=`, say), so a longer run never matches a prefix of
   * itself. Every other character, punctuation included, ends the token.
   */
  | { kind: 'tokenEnd'; continuedBy?: string }
  /** Azure's own delimiter sets on each side. */
  | { kind: 'azureDelimited' }

const AZURE_BEFORE = String.raw`^|[\s\\'"\x60(),=:>]`
const AZURE_AFTER = String.raw`$|[\s\\'"\x60),<]`

export function withBoundary(token: string, boundary: TokenBoundary): string {
  switch (boundary.kind) {
    case 'anywhere':
      return token
    case 'word':
      return String.raw`\b(?:${token})\b`
    case 'wordStart':
      return String.raw`\b(?:${token})`
    case 'tokenEnd':
      return String.raw`\b(?:${token})(?![\w${boundary.continuedBy ?? ''}-])`
    case 'azureDelimited':
      return `(?<=${AZURE_BEFORE})(?:${token})(?=${AZURE_AFTER})`
  }
}
