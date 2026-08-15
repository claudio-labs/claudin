/**
 * Decoding text that is not UTF-8.
 *
 * ripgrep's `--encoding` takes an Encoding Standard label — `utf-16le`,
 * `shift_jis`, `windows-1252`, `euc-jp`, `gbk`. Node's `readFile` takes a
 * `BufferEncoding`, which is a much smaller set, so a label Grep accepts is
 * generally NOT one `readFile` can use. `TextDecoder` covers the same label
 * space ripgrep does (Node ships full ICU), which is why every non-UTF-8 read
 * in this repo routes through here instead of through `readFile`'s `encoding`
 * option.
 *
 * The point of sharing it: a search that can reach a Shift-JIS file is only
 * half an answer if the follow-up read of that same file cannot.
 */

/**
 * Spellings that mean "no override" — the caller keeps its existing UTF-8
 * path rather than routing through TextDecoder.
 *
 * Deliberately just these two, not a normalization table. Everything else
 * takes the override, including labels Node could technically handle
 * (`utf16le`, `latin1`), so there is exactly one decoder for every non-UTF-8
 * label and the two paths can never disagree about who owns one.
 */
const UTF8_LABELS = new Set(['utf8', 'utf-8'])

export function isUtf8Label(label: string): boolean {
  return UTF8_LABELS.has(label.trim().toLowerCase())
}

/**
 * Resolves an `encoding` input to the label that should override the UTF-8
 * read, or null when the caller should stay on its default path. Undefined
 * and any spelling of UTF-8 both mean "no override".
 */
export function encodingOverride(
  label: string | undefined,
): string | null {
  if (label === undefined) return null
  return isUtf8Label(label) ? null : label
}

export class UnknownEncodingError extends Error {
  constructor(public readonly label: string) {
    super(
      `Unknown encoding "${label}". Use an Encoding Standard label, e.g. utf-8, utf-16le, utf-16be, latin1, windows-1252, shift_jis, euc-jp, euc-kr, gbk or big5.`,
    )
    this.name = 'UnknownEncodingError'
  }
}

/**
 * Non-fatal on purpose: undecodable bytes become U+FFFD rather than throwing,
 * which is what ripgrep does with the same label. A file that is *mostly* the
 * declared encoding still reads.
 *
 * BOM handling is left at the WHATWG default (`ignoreBOM: false`), so a
 * leading BOM is consumed here and callers that also strip U+FEFF find
 * nothing left to strip.
 */
export function createTextDecoder(label: string): TextDecoder {
  try {
    return new TextDecoder(label)
  } catch {
    // RangeError is the only failure mode, and its message names the label
    // without saying what a valid one looks like.
    throw new UnknownEncodingError(label)
  }
}

export function decodeBuffer(buf: Uint8Array, label: string): string {
  return createTextDecoder(label).decode(buf)
}

/**
 * Validates a label without reading anything, so a bad one fails before the
 * filesystem work rather than after it.
 */
export function assertKnownEncoding(label: string): void {
  createTextDecoder(label)
}
