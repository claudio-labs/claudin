/**
 * How a `MEMORY.md` index is fitted to its caps before it enters context —
 * a leaf of the memory slice, so what only needs the caps (the hygiene
 * findings, the write tools' notes) imports them without the prompt graph
 * memdir.ts pulls in. memdir.ts re-exports all of it.
 */
import { ENTRYPOINT_NAME, INDEX_LINK_TARGET_RE } from 'src/memory/memdir/memoryScopes.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { plural } from 'src/shared/text/stringUtils.js'

export const MAX_ENTRYPOINT_LINES = 200
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
export const MAX_ENTRYPOINT_BYTES = 25_000

// A MEMORY.md index entry is a top-level bullet: `- [Title](file.md) — hook`.
// Matched on the bullet rather than on the link because a few entries group
// several memories behind one line and open with prose instead of `[` — those
// are entries too. Anchored at column 0 so a nested sub-bullet is not one.
const INDEX_ENTRY_RE = /^-[ \t]+\S/gm
// The same bullet, tested on one line.
const ENTRY_LINE_RE = new RegExp(INDEX_ENTRY_RE.source)
// An entry's hook is what follows the em dash after its LAST link — a line
// grouping several memories (`- Censuses: [a](a.md) · [b](b.md) — hook`) has
// its hook after the final one, and a title may carry a dash of its own.
const HOOK_SEPARATOR = ' — '
// The line length every memory prompt asks of an index entry.
const INDEX_LINE_CHARS = 150

/**
 * Count the pointer lines in a MEMORY.md index body.
 *
 * Pass the post-fitEntrypointContent `content` for what actually entered
 * context, and `rawContent` for what the file holds on disk; the gap between
 * the two is what a cap cut off. The `> NOTE:` / `> WARNING:` footer the fit
 * appends is not a bullet, so it never skews the count.
 */
export function countIndexEntries(indexContent: string): number {
  return indexContent.match(INDEX_ENTRY_RE)?.length ?? 0
}

/** `line` without its hook, or null when it is not an entry or has none. */
function entryWithoutHook(line: string): string | null {
  if (!ENTRY_LINE_RE.test(line)) return null
  let linkEnd = -1
  for (const match of line.matchAll(INDEX_LINK_TARGET_RE)) linkEnd = match.index + match[0].length
  if (linkEnd < 0) return null
  const hook = line.indexOf(HOOK_SEPARATOR, linkEnd)
  return hook < 0 ? null : line.slice(0, hook)
}

// UTF-8 byte constants for the byte-space cut below.
const NEWLINE_BYTE = 0x0a
const CONTINUATION_MASK = 0xc0
const CONTINUATION_BITS = 0x80

/**
 * Cut `text` to the byte cap in byte space, so the cap actually bounds bytes.
 * Prefers the last newline before the cap so a line is not sliced; otherwise
 * a hard cut.
 */
function cutToByteCap(text: string): string {
  const buf = Buffer.from(text, 'utf8')
  const newlineByte = buf.lastIndexOf(NEWLINE_BYTE, MAX_ENTRYPOINT_BYTES)
  let cutAt = newlineByte > 0 ? newlineByte : MAX_ENTRYPOINT_BYTES
  // Never slice through a multibyte character. A hard cut landing on a
  // continuation byte (0b10xxxxxx) decodes to U+FFFD, which is 3 bytes and
  // would push the body back over the cap — back up to the char's first byte.
  while (cutAt > 0 && (buf[cutAt]! & CONTINUATION_MASK) === CONTINUATION_BITS) {
    cutAt--
  }
  return buf.subarray(0, cutAt).toString('utf8')
}

export type EntrypointFit = {
  content: string
  lineCount: number
  byteCount: number
  overLineCap: boolean
  overByteCap: boolean
  /** Entries that entered context without their hook, to fit. */
  shortenedEntryCount: number
}

/**
 * Fit MEMORY.md content to the line AND byte caps. Within both it is returned
 * as is, byte for byte. Over either, it gives up what costs the model least
 * first — coverage before detail, the order ai-memory's brief budget uses:
 *   1. the blank lines;
 *   2. the hooks, from the bottom of the index up, so every entry keeps its
 *      `- [Title](file.md)` pointer and the top keeps its detail;
 *   3. only then the tail — the lines past the line cap, then the bytes past
 *      the byte cap at the last newline before it.
 * A `> NOTE:` says what was shortened when nothing was lost, a `> WARNING:`
 * when the tail was.
 *
 * Shared by buildMemoryPrompt and claudemd getMemoryFiles.
 */
export function fitEntrypointContent(raw: string): EntrypointFit {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  // Real UTF-8 size. `.length` counts UTF-16 code units, which undercounts
  // multibyte content (CJK/emoji are 3-4 bytes each) by up to ~4x — a large
  // non-ASCII index would slip past this budget entirely while reporting
  // overByteCap: false, and the footer names the value as a file size.
  const byteCount = Buffer.byteLength(trimmed)

  const overLineCap = lineCount > MAX_ENTRYPOINT_LINES
  // Check original byte count — long lines are the failure mode the byte cap
  // targets, so the size after dropping lines would understate the footer.
  const overByteCap = byteCount > MAX_ENTRYPOINT_BYTES

  if (!overLineCap && !overByteCap) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      overLineCap,
      overByteCap,
      shortenedEntryCount: 0,
    }
  }

  const lines = contentLines.filter(line => line.trim() !== '')
  const lineCut = lines.length > MAX_ENTRYPOINT_LINES
  if (lineCut) lines.length = MAX_ENTRYPOINT_LINES
  let bytes = Buffer.byteLength(lines.join('\n'))
  const shortenedAt: number[] = []
  for (let i = lines.length - 1; i >= 0 && bytes > MAX_ENTRYPOINT_BYTES; i--) {
    const short = entryWithoutHook(lines[i]!)
    if (short === null) continue
    bytes -= Buffer.byteLength(lines[i]!) - Buffer.byteLength(short)
    lines[i] = short
    shortenedAt.push(i)
  }
  const byteCut = bytes > MAX_ENTRYPOINT_BYTES
  const body = byteCut ? cutToByteCap(lines.join('\n')) : lines.join('\n')
  // What reached context: a shortened entry the byte cut then dropped is not shown at all.
  const kept = body.split('\n').length
  const shortenedEntryCount = shortenedAt.filter(i => i < kept).length

  const reason = !overLineCap
    ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
    : !overByteCap
      ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
      : `${lineCount} lines and ${formatFileSize(byteCount)}`
  const lost = lineCut || byteCut
  const footer = [
    `> ${lost ? 'WARNING' : 'NOTE'}: ${ENTRYPOINT_NAME} is ${reason}.`,
    lost ? 'Only part of it was loaded.' : 'Every entry was loaded, its blank lines dropped.',
    shortenedEntryCount > 0
      ? `${shortenedEntryCount} ${plural(shortenedEntryCount, 'entry is', 'entries are')} shown without their hook — open a file for its detail.`
      : '',
    `Keep index entries to one line under ~${INDEX_LINE_CHARS} chars; ${lost ? 'move detail into topic files' : 'or run /memory tidy'}.`,
  ]
    .filter(Boolean)
    .join(' ')

  return {
    content: `${body}\n\n${footer}`,
    lineCount,
    byteCount,
    overLineCap,
    overByteCap,
    shortenedEntryCount,
  }
}
